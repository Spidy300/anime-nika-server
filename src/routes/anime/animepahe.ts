import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import { ANIME } from '@consumet/extensions';
import chalk from 'chalk';
import * as cheerio from 'cheerio'; // Uses your existing cheerio

// --- CUSTOM GOGO SCRAPER (Bypasses Library) ---
class CustomGogo {
    baseUrl = "https://anitaku.pe"; // Current working Gogo domain

    async search(query: string) {
        try {
            const res = await fetch(`${this.baseUrl}/search.html?keyword=${encodeURIComponent(query)}`);
            const html = await res.text();
            const $ = cheerio.load(html);
            const results: any[] = [];

            $('.last_episodes .items li').each((i, el) => {
                const title = $(el).find('.name a').text().trim();
                const id = $(el).find('.name a').attr('href')?.replace('/category/', '').trim();
                const image = $(el).find('.img a img').attr('src');
                const releaseDate = $(el).find('.released').text().trim();
                if (id && title) results.push({ id, title, image, releaseDate });
            });
            return { results };
        } catch (e) { throw new Error("Gogo Search Failed"); }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const res = await fetch(`${this.baseUrl}/category/${id}`);
            const html = await res.text();
            const $ = cheerio.load(html);

            const title = $('.anime_info_body_bg h1').text().trim();
            const image = $('.anime_info_body_bg img').attr('src');
            const description = $('.anime_info_body_bg .type').eq(1).text().replace('Plot Summary:', '').trim();

            // Get Episode ID Start/End
            const epStart = $('#episode_page a').first().attr('ep_start');
            const epEnd = $('#episode_page a').last().attr('ep_end');
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');

            // Fetch Episode List via AJAX (Gogo logic)
            const epUrl = `https://ajax.gogocdn.net/ajax/load-list-episode?ep_start=${epStart}&ep_end=${epEnd}&id=${movie_id}&default_ep=${0}&alias=${alias}`;
            const epRes = await fetch(epUrl);
            const epHtml = await epRes.text();
            const $ep = cheerio.load(epHtml);
            const episodes: any[] = [];

            $ep('li').each((i, el) => {
                const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                if (epId) episodes.push({ id: epId, number: Number(epNum) });
            });

            return { id, title, image, description, episodes: episodes.reverse() };
        } catch (e) { throw new Error("Gogo Info Failed"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const res = await fetch(`${this.baseUrl}/${episodeId}`);
            const html = await res.text();
            const $ = cheerio.load(html);
            
            const iframe = $('iframe').first().attr('src');
            if (!iframe) throw new Error("No video frame found");

            // Use the library's extractor for the final link if possible, 
            // or return the iframe to be handled by proxy.
            return { 
                sources: [{ url: iframe, quality: 'default', isM3U8: false }],
                headers: { Referer: this.baseUrl } 
            };
        } catch (e) { throw new Error("Gogo Watch Failed"); }
    }
}

const customGogo = new CustomGogo();

const routes = async (fastify: FastifyInstance, options: any) => {

  // --- HELPER: LAZY LOAD PROVIDERS ---
  const getProvider = (name: string) => {
      try {
          if (name === 'kai') return new ANIME.AnimeKai();
          if (name === 'pahe') return new ANIME.AnimePahe();
          if (name === 'hianime') return new ANIME.Hianime();
          // 🟢 RETURN CUSTOM GOGO
          if (name === 'gogo') return customGogo;
      } catch (e) { return null; }
      return null;
  };

  // --- HELPER: SAFE RUNNER ---
  const safeRun = async (providerName: string, action: string, fn: (p: any) => Promise<any>, reply: any) => {
    try {
        console.log(chalk.blue(`[${providerName}] Request: ${action}...`));
        const provider = getProvider(providerName.toLowerCase());
        if (!provider) throw new Error(`${providerName} could not be initialized.`);
        
        const result = await fn(provider); // No timeout needed for custom scraper
        console.log(chalk.green(`   -> [${providerName}] Success!`));
        return reply.send(result);

    } catch (e: any) {
        console.error(chalk.red(`   -> ❌ [${providerName}] Failed:`), e.message);
        return reply.status(200).send({ error: e.message, results: [] }); 
    }
  };

  // --- ROUTES ---

  // CUSTOM GOGO ROUTES
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  // OTHERS
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

  fastify.get('/kai/search/:query', (req: any, res) => safeRun('Kai', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/kai/info/:id', (req: any, res) => safeRun('Kai', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/kai/watch/:episodeId', (req: any, res) => safeRun('Kai', `Watch ${req.params.episodeId}`, (p) => p.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/:query', (req: any, res) => safeRun('Pahe', `Search ${req.params.query}`, (p) => p.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', `Info ${req.params.id}`, (p) => p.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', `Watch ${req.params.episodeId}`, (p) => {
      let id = req.params.episodeId;
      if(id.includes("~")) id = id.replace(/~/g,"/");
      return p.fetchEpisodeSources(id);
  }, res));

  // --- PROXY ---
  fastify.get('/proxy', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
        const { url } = request.query as { url: string };
        if (!url) return reply.status(400).send("Missing URL");
        
        const response = await fetch(url, { headers: { 'Referer': new URL(url).origin, 'User-Agent': "Mozilla/5.0" } });
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Content-Type", response.headers.get("content-type") || "application/octet-stream");
        const buffer = await response.arrayBuffer();
        reply.send(Buffer.from(buffer));
    } catch (error) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;