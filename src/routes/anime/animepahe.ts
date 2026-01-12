import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// --- CUSTOM GOGO SCRAPER ---
class CustomGogo {
    // Re-ordered mirrors: gogoanime3.co is often most reliable
    mirrors = [
        "https://gogoanime3.co",
        "https://anitaku.pe",
        "https://gogoanime.hu",
        "https://anitaku.so"
    ];

    async fetchHTML(path: string) {
        for (const domain of this.mirrors) {
            try {
                const targetUrl = `${domain}${path}`;
                // console.log(chalk.gray(`   ...trying ${targetUrl}`));
                const res = await fetch(targetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': domain
                    }
                });

                if (res.ok) {
                    const html = await res.text();
                    if (!html.includes("Just a moment") && !html.includes("WAF") && html.includes("<title>")) {
                        return { html, domain };
                    }
                }
            } catch (e) {}
        }
        throw new Error("All Gogo mirrors blocked.");
    }

    async search(query: string) {
        try {
            const { html } = await this.fetchHTML(`/search.html?keyword=${encodeURIComponent(query)}`);
            const $ = cheerio.load(html);
            const results: any[] = [];
            $('.last_episodes .items li').each((i, el) => {
                const title = $(el).find('.name a').text().trim();
                const id = $(el).find('.name a').attr('href')?.replace('/category/', '').trim();
                const image = $(el).find('.img a img').attr('src');
                if (id && title) results.push({ id, title, image });
            });
            // Fallback Guess
            if (results.length === 0) {
                 const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                 results.push({ id: guessId, title: query, image: "", releaseDate: "Guessed" });
            }
            return { results };
        } catch (e) { 
            const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
            return { results: [{ id: guessId, title: query, image: "", releaseDate: "Error Fallback" }] };
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const { html } = await this.fetchHTML(`/category/${id}`);
            const $ = cheerio.load(html);
            const title = $('.anime_info_body_bg h1').text().trim();
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            const ep_end = $('#episode_page a').last().attr('ep_end');

            if (!title) throw new Error("Blocked");

            const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
            const epRes = await fetch(ajaxUrl);
            const epHtml = await epRes.text();
            const $ep = cheerio.load(epHtml);
            const episodes: any[] = [];

            $ep('li').each((i, el) => {
                const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                if (epId) episodes.push({ id: epId, number: Number(epNum) });
            });
            return { id, title, episodes: episodes.reverse() };
        } catch (e: any) { throw new Error(e.message); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const { html } = await this.fetchHTML(`/${episodeId}`);
            const $ = cheerio.load(html);
            const iframe = $('iframe').first().attr('src');
            if (!iframe) throw new Error("No video frame found");
            return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
        } catch (e) { throw new Error("Gogo Watch Failed"); }
    }
}

// --- CUSTOM PAHE SCRAPER (Fixes the "null" bug) ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";

    async search(query: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`);
            const data: any = await res.json();
            const results = data.data.map((item: any) => ({
                id: item.session, // Pahe uses 'session' as ID
                title: item.title,
                image: item.poster
            }));
            return { results };
        } catch (e) { throw new Error("Pahe Search Failed"); }
    }

    async fetchAnimeInfo(id: string) {
        try {
            // Pahe API for episodes
            // We need to fetch the first page to get total episodes
            const res = await fetch(`${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`);
            const data: any = await res.json();
            
            let episodes: any[] = [];
            // Just get the first page of episodes (usually 30)
            // Ideally we loop through all pages, but for speed we grab page 1
            if(data.data) {
                episodes = data.data.map((ep: any) => ({
                    id: `${id}/${ep.session}`, // ID is "AnimeID/EpSession"
                    number: ep.episode
                }));
            }
            
            return { id, title: "AnimePahe", episodes };
        } catch (e) { throw new Error("Pahe Info Failed"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            // episodeId format: "AnimeID/EpSession"
            const [animeSession, epSession] = episodeId.split("/");
            
            // Get the player page
            const res = await fetch(`${this.baseUrl}/play/${animeSession}/${epSession}`);
            const html = await res.text();
            
            // Extract Kwik Link
            const kwikLink = html.match(/https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+/)?.[0];
            if(!kwikLink) throw new Error("No Kwik link found");

            return { 
                sources: [{ url: kwikLink, quality: '720p', isM3U8: false }],
                headers: { Referer: "https://kwik.cx/" }
            };
        } catch (e) { throw new Error("Pahe Watch Failed"); }
    }
}

const customGogo = new CustomGogo();
const customPahe = new CustomPahe();

const routes = async (fastify: FastifyInstance, options: any) => {

  const safeRun = async (providerName: string, fn: () => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] Running...`));
        const res = await fn();
        console.log(chalk.green(`   -> Success`));
        return reply.send(res);
    } catch (e: any) {
        console.error(chalk.red(`   -> Error:`), e.message);
        return reply.status(200).send({ error: e.message, results: [] });
    }
  };

  // 1. GOGO
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // 2. PAHE (Now Custom!)
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => customPahe.fetchEpisodeSources(req.params.episodeId), res));

  // 3. HIANIME (Standard - IP blocked but kept for backup)
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', async () => {
    const p = new ANIME.Hianime();
    const servers = ["vidcloud", "megacloud", "vidstreaming"];
    for (const server of servers) { try { return await p.fetchEpisodeSources(req.params.episodeId, server as any); } catch (e) {} }
    throw new Error("No servers");
  }, res));

  // 4. KAI
  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchEpisodeSources(req.params.episodeId), res));

  // PROXY
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        
        // Handle Kwik (Pahe) and Gogo headers
        let referer = "https://gogoanime3.co/";
        if (url.includes("kwik")) referer = "https://kwik.cx/";

        const response = await fetch(url, { headers: { 'Referer': referer, 'User-Agent': "Mozilla/5.0" } });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;