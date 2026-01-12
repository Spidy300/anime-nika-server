import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// --- MANUAL GOGO SCRAPER ---
class CustomGogo {
    // We use the main site. If search fails, we guess the ID.
    baseUrl = "https://anitaku.pe"; 

    async fetch(url: string) {
        try {
            const res = await fetch(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Referer': this.baseUrl
                }
            });
            if (!res.ok) throw new Error("Fetch failed");
            return await res.text();
        } catch (e) { return ""; }
    }

    async search(query: string) {
        // 1. Try real search
        try {
            const html = await this.fetch(`${this.baseUrl}/search.html?keyword=${encodeURIComponent(query)}`);
            const $ = cheerio.load(html);
            const results: any[] = [];

            $('.last_episodes .items li').each((i, el) => {
                const title = $(el).find('.name a').text().trim();
                const id = $(el).find('.name a').attr('href')?.replace('/category/', '').trim();
                const image = $(el).find('.img a img').attr('src');
                if (id && title) results.push({ id, title, image });
            });

            // 🟢 FORCE RESULT: If search blocked/empty, create a "Best Guess" result
            if (results.length === 0) {
                console.log(chalk.yellow("   -> Gogo Search blocked. forcing ID match..."));
                const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                results.push({
                    id: guessId,
                    title: query, // Use the user's query as title
                    image: "https://gogocdn.net/cover/naruto-shippuden.png", // Placeholder/Generic
                    releaseDate: "Guessed Match"
                });
            }
            return { results };
        } catch (e) {
            // Even on error, return the guess
            const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
            return { results: [{ id: guessId, title: query, image: "", releaseDate: "Error Fallback" }] };
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const html = await this.fetch(`${this.baseUrl}/category/${id}`);
            const $ = cheerio.load(html);
            const title = $('.anime_info_body_bg h1').text().trim();
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            const ep_end = $('#episode_page a').last().attr('ep_end');

            if (!title) throw new Error("Anime not found (blocked or invalid ID)");

            const ajaxUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
            const epHtml = await this.fetch(ajaxUrl);
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
            const html = await this.fetch(`${this.baseUrl}/${episodeId}`);
            const $ = cheerio.load(html);
            const iframe = $('iframe').first().attr('src');
            if (!iframe) throw new Error("No video frame found");
            return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
        } catch (e) { throw new Error("Gogo Watch Failed"); }
    }
}

const customGogo = new CustomGogo();

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

  // --- DEFINED ROUTES ---

  // 1. GOGO (Manual)
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // 2. KAI (Fixing 404)
  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', () => new ANIME.AnimeKai().fetchEpisodeSources(req.params.episodeId), res));

  // 3. HIANIME
  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', () => new ANIME.Hianime().fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', async () => {
    const p = new ANIME.Hianime();
    const servers = ["vidcloud", "megacloud", "vidstreaming"];
    for (const server of servers) { try { return await p.fetchEpisodeSources(req.params.episodeId, server); } catch (e) {} }
    throw new Error("No servers");
  }, res));

  // 4. PAHE (Restored)
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => new ANIME.AnimePahe().search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => new ANIME.AnimePahe().fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => {
      let id = req.params.episodeId.includes("~") ? req.params.episodeId.replace(/~/g,"/") : req.params.episodeId;
      return new ANIME.AnimePahe().fetchEpisodeSources(id);
  }, res));

  // PROXY
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        const response = await fetch(url, { headers: { 'Referer': 'https://anitaku.pe/', 'User-Agent': "Mozilla/5.0" } });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;