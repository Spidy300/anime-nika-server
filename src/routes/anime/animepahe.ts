import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// --- SHOTGUN GOGO SCRAPER ---
class CustomGogo {
    // 🟢 TRY ALL THESE MIRRORS
    mirrors = [
        "https://anitaku.so",       // Mirror 1
        "https://gogoanime.hu",     // Mirror 2
        "https://gogoanime.cl",     // Mirror 3
        "https://gogoanime3.co",    // Mirror 4
        "https://anitaku.pe"        // Mirror 5
    ];

    // Helper: Tries all mirrors until one gives valid HTML
    async fetchHTML(path: string) {
        for (const domain of this.mirrors) {
            try {
                const targetUrl = `${domain}${path}`;
                console.log(chalk.yellow(`   ...trying ${targetUrl}`));

                const res = await fetch(targetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Referer': domain
                    }
                });

                if (res.ok) {
                    const html = await res.text();
                    // Check for Cloudflare Captcha
                    if (!html.includes("Just a moment") && !html.includes("Verify you are human") && !html.includes("WAF")) {
                        return { html, domain }; // Success!
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

            // Fallback: Guess ID
            if (results.length === 0) {
                console.log(chalk.yellow("   -> Gogo Search empty. Forcing ID match..."));
                const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                
                // Validate guess
                try {
                    const { html: infoHtml } = await this.fetchHTML(`/category/${guessId}`);
                    const $info = cheerio.load(infoHtml);
                    const title = $info('.anime_info_body_bg h1').text().trim();
                    if (title) results.push({ id: guessId, title, image: "", releaseDate: "Direct Match" });
                } catch(e) {}
            }
            return { results };
        } catch (e) {
             const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-');
             return { results: [{ id: guessId, title: query, image: "", releaseDate: "Force Guess" }] };
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            // Loop through mirrors to find the Info Page
            const { html, domain } = await this.fetchHTML(`/category/${id}`);
            const $ = cheerio.load(html);

            const title = $('.anime_info_body_bg h1').text().trim();
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            const ep_end = $('#episode_page a').last().attr('ep_end');

            if (!title) throw new Error("Blocked");

            // Fetch Episodes (AJAX usually works if we have the movie_id)
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

            console.log(chalk.green(`   -> Gogo Found ${episodes.length} episodes.`));
            return { id, title, episodes: episodes.reverse() };
        } catch (e: any) { throw new Error("Gogo Info Failed: " + e.message); }
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

  // ROUTES
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // STANDARD PROVIDERS
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