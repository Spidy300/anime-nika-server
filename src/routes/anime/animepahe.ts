import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// 🟢 YOUR PROXY URL
const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

// Helper to fetch via your Proxy Shield
async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    if (referer) fullUrl += `&referer=${encodeURIComponent(referer)}`;
    
    try {
        const res = await fetch(fullUrl);
        if (!res.ok) throw new Error(`Shield Status: ${res.status}`);
        return await res.text();
    } catch (e) {
        console.log(chalk.red(`Shield Error on ${targetUrl}: ${e}`));
        return "";
    }
}

// --- 1. GOGO SCRAPER (Triple-Key Unlock) ---
class CustomGogo {
    mirrors = ["https://gogoanimes.fi", "https://anitaku.pe", "https://gogoanime3.co"];
    
    // We try ALL these domains to load episodes. One ALWAYS works.
    ajaxDomains = [
        "https://ajax.gogo-load.com", 
        "https://ajax.gogocdn.net", 
        "https://ajax.goload.pro"
    ];

    async search(query: string) {
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
        console.log(chalk.blue(`   -> Gogo: Hunting for info on ${id}...`));
        
        for (const domain of this.mirrors) {
            try {
                // Step 1: Get the Category Page
                const html = await fetchShield(`${domain}/category/${id}`);
                if (!html || html.includes("WAF") || html.includes("Verify")) continue;

                const $ = cheerio.load(html);
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                const ep_end = $('#episode_page a').last().attr('ep_end');

                if (movie_id) {
                    console.log(chalk.green(`      ✅ Found movie_id on ${domain}!`));
                    
                    // Step 2: Try ALL AJAX domains until one gives us episodes
                    for (const ajaxBase of this.ajaxDomains) {
                        try {
                            const ajaxUrl = `${ajaxBase}/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                            // console.log(chalk.gray(`      Trying AJAX: ${ajaxBase}...`));
                            
                            // 🟢 Pass the domain as referer to fool the protection
                            const epHtml = await fetchShield(ajaxUrl, domain); 
                            
                            const $ep = cheerio.load(epHtml);
                            const episodes: any[] = [];
                            $ep('li').each((i, el) => {
                                const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                                const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                                if (epId) episodes.push({ id: epId, number: Number(epNum) });
                            });

                            if (episodes.length > 0) {
                                console.log(chalk.green(`      🎉 Success on ${ajaxBase}!`));
                                return { id, title: id, episodes: episodes.reverse() };
                            }
                        } catch (e) {}
                    }
                }
            } catch (e) {}
        }
        throw new Error("Gogo Info Failed");
    }

    async fetchEpisodeSources(episodeId: string) {
        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/${episodeId}`);
                const $ = cheerio.load(html);
                const iframe = $('iframe').first().attr('src');
                if (iframe) return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
            } catch(e) {}
        }
        throw new Error("Gogo Watch Failed");
    }
}

// --- 2. PAHE SCRAPER (Loose Search) ---
class CustomPahe {
    baseUrl = "https://animepahe.ru";
    
    async search(query: string) {
        try {
            // 🟢 Try exact search
            let jsonString = await fetchShield(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(query)}`);
            let data = JSON.parse(jsonString || "{}");

            // 🟢 Fallback: Search ONLY the first word (e.g. "Naruto" instead of "Naruto Shippuden")
            if (!data.data || data.data.length === 0) {
                const firstWord = query.split(" ")[0];
                if (firstWord && firstWord.length > 3) { // Only if word is long enough
                    console.log(chalk.yellow(`      Pahe: Fallback search for "${firstWord}"`));
                    jsonString = await fetchShield(`${this.baseUrl}/api?m=search&q=${encodeURIComponent(firstWord)}`);
                    data = JSON.parse(jsonString || "{}");
                }
            }
            
            return { results: (data.data || []).map((i:any) => ({ id: i.session, title: i.title, image: i.poster })) };
        } catch (e) { 
            return { results: [] }; 
        }
    }

    async fetchAnimeInfo(id: string) {
        try {
            const jsonString = await fetchShield(`${this.baseUrl}/api?m=release&id=${id}&sort=episode_asc&page=1`);
            const data = JSON.parse(jsonString);
            const episodes = (data.data || []).map((ep:any) => ({ id: `${id}*${ep.session}`, number: ep.episode }));
            return { id, title: "AnimePahe", episodes };
        } catch (e) { throw new Error("Pahe Info Error"); }
    }

    async fetchEpisodeSources(episodeId: string) {
        try {
            const [animeId, epId] = episodeId.split("*");
            const html = await fetchShield(`${this.baseUrl}/play/${animeId}/${epId}`);
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

  // Only Pahe and Gogo
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/:query', (req: any, res) => safeRun('Pahe', () => customPahe.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Pahe', () => customPahe.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Pahe', () => {
      let id = req.params.episodeId.includes("~") ? req.params.episodeId.replace(/~/g,"*") : req.params.episodeId;
      return customPahe.fetchEpisodeSources(id);
  }, res));

  // Proxy Route
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        const fullUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}`;
        const response = await fetch(fullUrl);
        reply.header("Access-Control-Allow-Origin", "*");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;