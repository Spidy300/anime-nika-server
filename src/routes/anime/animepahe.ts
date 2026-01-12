import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    if (referer) fullUrl += `&referer=${encodeURIComponent(referer)}`;
    
    try {
        const res = await fetch(fullUrl);
        if (!res.ok) throw new Error(`Shield Status: ${res.status}`);
        return await res.text();
    } catch (e) {
        console.log(chalk.red(`   ⚠️ Proxy Fail on ${targetUrl}: ${e}`));
        return "";
    }
}

class CustomGogo {
    // 🟢 CHANGED ORDER: Put anitaku.pe first (often less blocked)
    mirrors = ["https://anitaku.pe", "https://gogoanime3.co", "https://gogoanimes.fi"];
    
    ajaxDomains = [
        "https://ajax.gogo-load.com", 
        "https://ajax.gogocdn.net", 
        "https://ajax.goload.pro",
        "https://disqus.gogocdn.net"
    ];

    async search(query: string) {
        const guessId = query.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        return { 
            results: [{ 
                id: guessId, 
                title: query, 
                image: "https://gogocdn.net/cover/naruto-shippuden.png", 
                releaseDate: "Gogo Only" 
            }] 
        };
    }

    async fetchAnimeInfo(id: string) {
        console.log(chalk.blue(`   -> Gogo: Hunting for info on ${id}...`));
        
        for (const domain of this.mirrors) {
            console.log(chalk.gray(`      Trying mirror: ${domain}`));
            const html = await fetchShield(`${domain}/category/${id}`);
            
            if (!html || html.includes("WAF") || html.includes("Verify")) {
                console.log(chalk.yellow(`      ⚠️ Blocked/Captcha on ${domain}`));
                continue;
            }

            const $ = cheerio.load(html);
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            let ep_end = $('#episode_page a').last().attr('ep_end');
            if (!ep_end) ep_end = "2000"; 

            if (movie_id) {
                console.log(chalk.green(`      ✅ Found movie_id: ${movie_id} on ${domain}`));
                
                for (const ajaxBase of this.ajaxDomains) {
                    try {
                        const ajaxUrl = `${ajaxBase}/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                        const epHtml = await fetchShield(ajaxUrl, domain); 
                        
                        // 🟢 CAPTCHA CHECK
                        if (epHtml.includes("security") || epHtml.includes("captcha")) {
                             console.log(chalk.red(`      ⛔ Captcha hit on ${ajaxBase}`));
                             continue;
                        }

                        const $ep = cheerio.load(epHtml);
                        const episodes: any[] = [];
                        $ep('li').each((i, el) => {
                            const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                            const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                            if (epId) episodes.push({ id: epId, number: Number(epNum) });
                        });

                        if (episodes.length > 0) {
                            console.log(chalk.green(`      🎉 Success: Connected to ${ajaxBase} (${episodes.length} eps)`));
                            return { id, title: id, episodes: episodes.reverse() };
                        } else {
                             // Log what we got if it failed (first 100 chars)
                             console.log(chalk.yellow(`      ⚠️ Empty list from ${ajaxBase}. Response start: ${epHtml.substring(0, 100)}`));
                        }
                    } catch (e) {}
                }
            }
        }
        throw new Error("Gogo Info Failed (All mirrors blocked)");
    }

    async fetchEpisodeSources(episodeId: string) {
        for (const domain of this.mirrors) {
            const html = await fetchShield(`${domain}/${episodeId}`);
            if(html) {
                const $ = cheerio.load(html);
                const iframe = $('iframe').first().attr('src');
                if (iframe) return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
            }
        }
        throw new Error("Gogo Watch Failed");
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

  // 🟢 Force Gogo
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // Redirect Pahe
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

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