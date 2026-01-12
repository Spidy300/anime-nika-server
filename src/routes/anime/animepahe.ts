import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';
import { ANIME } from '@consumet/extensions';

// --- GOGO API BYPASS (No HTML Parsing) ---
class CustomGogo {
    baseUrl = "https://anitaku.pe"; // Base for API calls

    async search(query: string) {
        // Blind Trust: Always return a result so the user can click
        const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return { 
            results: [{ 
                id: guessId, 
                title: query, 
                image: "https://gogocdn.net/cover/naruto-shippuden.png", 
                releaseDate: "Force Match" 
            }] 
        };
    }

    async fetchAnimeInfo(id: string) {
        // 🟢 DIRECT API CALL: Bypass the "Category" page entirely
        // We guess the movie_id is the same as the slug (often works) or try a standard range.
        // For Naruto Shippuden, the ID is actually distinct, so we try a "brute force" approach on the episode loader.
        
        try {
            // Step 1: Try to fetch the episode list directly using the alias
            // alias usually equals the ID (e.g. naruto-shippuden)
            const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=5000&id=&default_ep=0&alias=${id}`;
            
            const res = await fetch(ajaxUrl);
            if(!res.ok) throw new Error("API Blocked");
            
            const html = await res.text();
            const $ = cheerio.load(html);
            const episodes: any[] = [];

            $('li').each((i, el) => {
                const epId = $(el).find('a').attr('href')?.trim().replace('/', '');
                const epNum = $(el).find('.name').text().replace('EP ', '').trim();
                if (epId) episodes.push({ id: epId, number: Number(epNum) });
            });

            if (episodes.length === 0) throw new Error("No episodes found");

            return { id, title: id, episodes: episodes.reverse() };
        } catch (e: any) {
            console.log(chalk.red(`   -> Gogo API failed: ${e.message}`));
            throw new Error("Gogo Info Failed");
        }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            // Fetch the embed page source directly
            const res = await fetch(`${this.baseUrl}/${episodeId}`);
            const html = await res.text();
            
            const $ = cheerio.load(html);
            const iframe = $('iframe').first().attr('src');
            
            if (!iframe) throw new Error("No video iframe");
            
            // If it's a relative URL, fix it
            const finalUrl = iframe.startsWith('//') ? `https:${iframe}` : iframe;
            
            return { sources: [{ url: finalUrl, quality: 'default', isM3U8: false }] };
        } catch (e) { throw new Error("Gogo Watch Failed"); }
    }
}

// --- PAHE SCRAPER (Improved Search) ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };

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
            const episodes = (data.data || []).map((ep:any) => ({ id: `${id}*${ep.session}`, number: ep.episode }));
            return { id, title: "AnimePahe", episodes };
        } catch (e) { throw new Error("Pahe Info Error"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            if(!episodeId.includes("*") && !episodeId.includes("~")) throw new Error("Invalid ID");
            const [animeId, epId] = episodeId.replace("~", "*").split("*");
            
            const res = await fetch(`${this.baseUrl}/play/${animeId}/${epId}`, { headers: this.headers });
            const html = await res.text();
            
            const kwikMatch = html.match(/https:\/\/kwik\.cx\/e\/[a-zA-Z0-9]+/);
            if(!kwikMatch) throw new Error("Kwik link missing");
            
            return { sources: [{ url: kwikMatch[0], quality: '720p', isM3U8: false }] };
        } catch (e: any) { throw new Error("Pahe Watch Error: " + e.message); }
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

  // 1. GOGO (Priority)
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // 2. PAHE
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => {
      let id = req.params.episodeId.includes("~") ? req.params.episodeId.replace(/~/g,"*") : req.params.episodeId;
      return customPahe.fetchEpisodeSources(id);
  }, res));

  // 3. HIANIME (Backup)
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', async () => {
    const p = new ANIME.Hianime();
    const servers = ["vidcloud", "megacloud", "vidstreaming", "streamtape"];
    for (const server of servers) { try { return await p.fetchEpisodeSources(req.params.episodeId, server as any); } catch (e) {} }
    throw new Error("No servers");
  }, res));

  // PROXY
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
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