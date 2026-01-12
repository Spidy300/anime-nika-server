import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// --- RESILIENT GOGO SCRAPER ---
class CustomGogo {
    mirrors = [
        "https://anitaku.so",       
        "https://gogoanime3.co",
        "https://gogoanimes.fi",
        "https://gogoanime.hu",
        "https://anitaku.pe"
    ];

    async fetch(url: string, referer: string) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': referer
                }
            });
            if (!res.ok) throw new Error(`Status ${res.status}`);
            const text = await res.text();
            if (text.includes("Just a moment") || text.includes("Verify you are human")) throw new Error("Cloudflare Block");
            return text;
        } catch (e) { throw e; }
    }

    async search(query: string) {
        // Try all mirrors for search
        for (const domain of this.mirrors) {
            try {
                const html = await this.fetch(`${domain}/search.html?keyword=${encodeURIComponent(query)}`, domain);
                const $ = cheerio.load(html);
                const results: any[] = [];

                $('.last_episodes .items li').each((i, el) => {
                    const title = $(el).find('.name a').text().trim();
                    const id = $(el).find('.name a').attr('href')?.replace('/category/', '').trim();
                    const image = $(el).find('.img a img').attr('src');
                    if (id && title) results.push({ id, title, image });
                });

                if (results.length > 0) return { results };
                
                // If 0 results, try guessing ID on this mirror
                console.log(chalk.yellow(`   -> 0 results on ${domain}. Trying guess...`));
                const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                try {
                    const infoHtml = await this.fetch(`${domain}/category/${guessId}`, domain);
                    const $info = cheerio.load(infoHtml);
                    const title = $info('.anime_info_body_bg h1').text().trim();
                    if (title) {
                        return { results: [{ id: guessId, title, image: "", releaseDate: "Direct Match" }] };
                    }
                } catch(e) {}

            } catch (e) { console.log(chalk.gray(`   - ${domain} failed search.`)); }
        }
        return { results: [] };
    }

    async fetchAnimeInfo(id: string) {
        // Try ALL mirrors for Info (Crucial: one might block search but allow Info)
        for (const domain of this.mirrors) {
            try {
                console.log(chalk.yellow(`   ...fetching info from ${domain}`));
                const html = await this.fetch(`${domain}/category/${id}`, domain);
                const $ = cheerio.load(html);

                const title = $('.anime_info_body_bg h1').text().trim();
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                const ep_end = $('#episode_page a').last().attr('ep_end');

                if (!title || !movie_id) continue; // Try next mirror

                // Fetch Episodes
                const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                const epHtml = await this.fetch(ajaxUrl, domain);
                const $ep = cheerio.load(epHtml);
                const episodes: any[] = [];

                $ep('li').each((i, el) => {
                    const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                    const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                    if (epId) episodes.push({ id: epId, number: Number(epNum) });
                });

                if(episodes.length > 0) {
                    console.log(chalk.green(`   -> Success on ${domain}`));
                    return { id, title, episodes: episodes.reverse() };
                }
            } catch (e) {}
        }
        throw new Error("Gogo Info failed on all mirrors.");
    }

    async fetchEpisodeSources(episodeId: string) {
        for (const domain of this.mirrors) {
            try {
                const html = await this.fetch(`${domain}/${episodeId}`, domain);
                const $ = cheerio.load(html);
                const iframe = $('iframe').first().attr('src');
                if (iframe) return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
            } catch (e) {}
        }
        throw new Error("Gogo Watch failed.");
    }
}

// --- SAFE PAHE SCRAPER ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

    async search(query: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`, { headers: this.headers });
            const data: any = await res.json();
            return { results: (data.data || []).map((i:any) => ({ id: i.session, title: i.title, image: i.poster })) };
        } catch (e) { return { results: [] }; }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const res = await fetch(`${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`, { headers: this.headers });
            const data: any = await res.json();
            const episodes = (data.data || []).map((ep:any) => ({ id: `${id}::${ep.session}`, number: ep.episode }));
            return { id, title: "AnimePahe", episodes };
        } catch (e) { throw new Error("Pahe Info Error"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const [animeId, epId] = episodeId.split("::");
            const res = await fetch(`${this.baseUrl}/play/${animeId}/${epId}`, { headers: this.headers });
            const html = await res.text();
            const kwik = html.match(/https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+/)?.[0];
            if(!kwik) throw new Error("Kwik link missing");
            return { sources: [{ url: kwik, quality: '720p', isM3U8: false }] };
        } catch (e) { throw new Error("Pahe Watch Error"); }
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

  // PAHE (New Custom Implementation)
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => customPahe.fetchEpisodeSources(req.params.episodeId), res));

  // HIANIME & KAI (Standard)
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