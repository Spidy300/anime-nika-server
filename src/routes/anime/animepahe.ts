import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

class CustomGogo {
    // 🟢 EXTENDED MIRROR LIST (Mixed Secure/Insecure)
    mirrors = [
        "https://anitaku.so",       
        "https://gogoanime3.co",
        "https://gogoanimes.fi",
        "https://gogoanime.hu",
        "https://anitaku.pe",
        "https://gogoanime.cl",
        "https://gogoanime.tel"
    ];

    // Helper: Fetches and verifies content exists
    async fetchValidHTML(path: string, selectorToCheck: string) {
        for (const domain of this.mirrors) {
            try {
                const targetUrl = `${domain}${path}`;
                // console.log(chalk.gray(`   ...checking ${domain}`));

                const res = await fetch(targetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': domain
                    }
                });

                if (res.ok) {
                    const html = await res.text();
                    // 🟢 KEY FIX: Check if the HTML actually contains what we want
                    const $ = cheerio.load(html);
                    if ($(selectorToCheck).length > 0) {
                        console.log(chalk.green(`   -> Valid data found on ${domain}`));
                        return { $, domain }; // Return pre-loaded cheerio object
                    }
                }
            } catch (e) {}
        }
        return null; // All mirrors failed
    }

    async search(query: string) {
        try {
            // Check if '.last_episodes' exists (standard Gogo search result container)
            const data = await this.fetchValidHTML(`/search.html?keyword=${encodeURIComponent(query)}`, '.last_episodes');
            
            const results: any[] = [];
            
            if (data) {
                const { $ } = data;
                $('.last_episodes .items li').each((i, el) => {
                    const title = $(el).find('.name a').text().trim();
                    const id = $(el).find('.name a').attr('href')?.replace('/category/', '').trim();
                    const image = $(el).find('.img a img').attr('src');
                    if (id && title) results.push({ id, title, image });
                });
            }

            // Fallback: Force ID Guess if search failed
            if (results.length === 0) {
                console.log(chalk.yellow("   -> Gogo Search empty. Forcing ID match..."));
                const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                
                // Verify the guess exists
                const verify = await this.fetchValidHTML(`/category/${guessId}`, '.anime_info_body_bg');
                if (verify) {
                     const title = verify.$('.anime_info_body_bg h1').text().trim();
                     results.push({ 
                         id: guessId, 
                         title: title, 
                         image: verify.$('.anime_info_body_bg img').attr('src'), 
                         releaseDate: "Direct Match" 
                     });
                }
            }
            return { results };
        } catch (e) { 
             const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
             return { results: [{ id: guessId, title: query, image: "", releaseDate: "Force Guess" }] };
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            // 🟢 KEY FIX: Ensure we found the Title Header before accepting the page
            const data = await this.fetchValidHTML(`/category/${id}`, '.anime_info_body_bg h1');
            
            if (!data) throw new Error("All mirrors blocked or anime not found");
            const { $, domain } = data;

            const title = $('.anime_info_body_bg h1').text().trim();
            const image = $('.anime_info_body_bg img').attr('src');
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            const ep_end = $('#episode_page a').last().attr('ep_end');

            // Fetch Episodes via AJAX
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

            return { id, title, image, episodes: episodes.reverse() };
        } catch (e: any) { throw new Error(e.message); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            // Check for the video iframe
            const data = await this.fetchValidHTML(`/${episodeId}`, 'iframe');
            if (!data) throw new Error("Video page blocked");
            
            const { $ } = data;
            const iframe = $('iframe').first().attr('src');
            if (!iframe) throw new Error("No video frame found");

            return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
        } catch (e) { throw new Error("Gogo Watch Failed"); }
    }
}

// --- CUSTOM PAHE SCRAPER (Fixed) ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    
    // Header mimicking
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://animepahe.ru'
    };

    async search(query: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`, { headers: this.headers });
            if(!res.ok) throw new Error("Pahe Search Blocked");
            
            const data: any = await res.json();
            const results = (data.data || []).map((item: any) => ({
                id: item.session,
                title: item.title,
                image: item.poster
            }));
            return { results };
        } catch (e) { return { results: [] }; }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`, { headers: this.headers });
            const data: any = await res.json();
            let episodes: any[] = [];
            if(data.data) {
                episodes = data.data.map((ep: any) => ({
                    id: `${id}/${ep.session}`,
                    number: ep.episode
                }));
            }
            return { id, title: "AnimePahe", episodes };
        } catch (e) { throw new Error("Pahe Info Failed"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const [animeSession, epSession] = episodeId.split("/");
            const res = await fetch(`${this.baseUrl}/play/${animeSession}/${epSession}`, { headers: this.headers });
            const html = await res.text();
            const kwikLink = html.match(/https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+/)?.[0];
            if(!kwikLink) throw new Error("No Kwik link found");
            return { sources: [{ url: kwikLink, quality: '720p', isM3U8: false }] };
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

  // ROUTES
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', async () => {
    const p = new ANIME.Hianime();
    const servers = ["vidcloud", "megacloud", "vidstreaming"];
    for (const server of servers) { try { return await p.fetchEpisodeSources(req.params.episodeId, server as any); } catch (e) {} }
    throw new Error("No servers");
  }, res));

  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => customPahe.fetchEpisodeSources(req.params.episodeId), res));

  // PROXY
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        let referer = "https://gogoanime3.co/";
        if (url.includes("kwik")) referer = "https://kwik.cx/";
        const response = await fetch(url, { headers: { 'Referer': referer, 'User-Agent': "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;