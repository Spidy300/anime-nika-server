import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// --- ROBUST GOGO SCRAPER (Mirror Hopping) ---
class CustomGogo {
    domains = [
        "https://gogoanime.hu",     // 🟢 NEW: Often less protected
        "https://gogoanime3.co",
        "https://anitaku.pe"
    ];
    
    currentBase = this.domains[0];

    async fetchStealth(url: string) {
        for (const domain of this.domains) {
            try {
                let targetUrl = url;
                if (!url.startsWith(domain)) {
                    const path = url.replace(/^https?:\/\/[^\/]+/, '');
                    targetUrl = `${domain}${path}`;
                }
                console.log(chalk.yellow(`   ...requesting: ${targetUrl}`));
                const res = await fetch(targetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                        'Referer': 'https://www.google.com/'
                    }
                });
                if (res.ok) {
                    const text = await res.text();
                    if (!text.includes("Just a moment") && !text.includes("Verify you are human")) {
                        this.currentBase = domain;
                        return text;
                    }
                }
            } catch (e) {}
        }
        throw new Error("All Gogo mirrors blocked.");
    }

    async search(query: string) {
        try {
            const html = await this.fetchStealth(`${this.currentBase}/search.html?keyword=${encodeURIComponent(query)}`);
            const $ = cheerio.load(html);
            const results: any[] = [];

            $('.last_episodes .items li').each((i, el) => {
                const title = $(el).find('.name a').text().trim();
                const id = $(el).find('.name a').attr('href')?.replace('/category/', '').trim();
                const image = $(el).find('.img a img').attr('src');
                if (id && title) results.push({ id, title, image });
            });

            // 🟢 INTELLIGENT BYPASS
            if (results.length === 0) {
                console.log(chalk.cyan("   -> 0 Search Results. Trying Direct ID Guessing..."));
                const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                try {
                    const infoHtml = await this.fetchStealth(`${this.currentBase}/category/${guessId}`);
                    const $info = cheerio.load(infoHtml);
                    const title = $info('.anime_info_body_bg h1').text().trim();
                    if (title) results.push({ id: guessId, title, image: "", releaseDate: "Direct Match" });
                } catch(e) {}
            }
            return { results };
        } catch (e) { throw new Error("Gogo Search Failed"); }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const html = await this.fetchStealth(`${this.currentBase}/category/${id}`);
            const $ = cheerio.load(html);

            const title = $('.anime_info_body_bg h1').text().trim();
            const image = $('.anime_info_body_bg img').attr('src');
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            const ep_end = $('#episode_page a').last().attr('ep_end');

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
        } catch (e) { throw new Error("Gogo Info Failed"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const html = await this.fetchStealth(`${this.currentBase}/${episodeId}`);
            const $ = cheerio.load(html);
            const iframe = $('iframe').first().attr('src');
            if (!iframe) throw new Error("No video frame found");
            return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
        } catch (e) { throw new Error("Gogo Watch Failed"); }
    }
}

const customGogo = new CustomGogo();

const routes = async (fastify: FastifyInstance, options: any) => {
  const getProvider = (name: string) => {
      try {
          if (name === 'gogo') return customGogo;
          if (name === 'hianime') return new ANIME.Hianime();
          if (name === 'kai') return new ANIME.AnimeKai();
          if (name === 'pahe') return new ANIME.AnimePahe();
      } catch (e) { return null; }
      return null;
  };

  const safeRun = async (providerName: string, action: string, fn: (p: any) => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] Request: ${action}...`));
        const provider = getProvider(providerName.toLowerCase());
        const result = await fn(provider); 
        console.log(chalk.green(`   -> [${providerName}] Success!`));
        return reply.send(result);
    } catch (e: any) {
        console.error(chalk.red(`   -> ❌ [${providerName}] Failed:`), e.message);
        return reply.status(200).send({ error: e.message, results: [] }); 
    }
  };

  // ROUTES
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/hianime/search/:query', (req: any, res) => safeRun('Hianime', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/hianime/info/:id', (req: any, res) => safeRun('Hianime', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/hianime/watch/:episodeId', (req: any, res) => safeRun('Hianime', `Watch ${req.params.episodeId}`, async (p) => {
    const servers = ["vidcloud", "megacloud", "vidstreaming"];
    for (const server of servers) { 
        try { 
            const data = await p.fetchEpisodeSources(req.params.episodeId, server);
            if(data?.sources?.length > 0) return data;
        } catch (e) {} 
    }
    throw new Error("No servers found");
  }, res));

  // 🟢 RESTORED PAHE
  fastify.get('/:query', (req: any, res) => safeRun('Pahe', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', `Watch ${req.params.episodeId}`, (p) => {
      let id = req.params.episodeId;
      if(id.includes("~")) id = id.replace(/~/g,"/");
      return p.fetchEpisodeSources(id);
  }, res));

  fastify.get('/proxy', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { url } = request.query as { url: string };
        if (!url) return reply.status(400).send("Missing URL");
        const response = await fetch(url, { headers: { 'Referer': 'https://gogoanime3.co/', 'User-Agent': "Mozilla/5.0" } });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));
    } catch (error) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;