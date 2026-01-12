import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// 🟢 YOUR PROXY URL
const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    if (referer) fullUrl += `&referer=${encodeURIComponent(referer)}`;
    
    try {
        const res = await fetch(fullUrl);
        // If 530 happens, it throws here
        if (!res.ok) throw new Error(`Shield Status: ${res.status}`);
        return await res.text();
    } catch (e) {
        console.log(chalk.red(`   ⚠️ Proxy Fail on ${targetUrl}: ${e}`));
        return "";
    }
}

class CustomGogo {
    // 🟢 Try 3 mirrors for the main page
    mirrors = ["https://gogoanimes.fi", "https://anitaku.pe", "https://gogoanime3.co"];
    
    // 🟢 Try 4 AJAX servers for the episodes. One WILL work.
    ajaxDomains = [
        "https://ajax.gogo-load.com", 
        "https://ajax.gogocdn.net", 
        "https://ajax.goload.pro",
        "https://disqus.gogocdn.net"
    ];

    async search(query: string) {
        // Always return a match for Gogo
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
            // Step 1: Get Main Page
            const html = await fetchShield(`${domain}/category/${id}`);
            if (!html || html.includes("WAF")) continue;

            const $ = cheerio.load(html);
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            const ep_end = $('#episode_page a').last().attr('ep_end');

            if (movie_id) {
                console.log(chalk.green(`      ✅ Found movie_id on ${domain}!`));
                
                // Step 2: Get Episodes (The Hard Part)
                for (const ajaxBase of this.ajaxDomains) {
                    try {
                        const ajaxUrl = `${ajaxBase}/ajax/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                        
                        // Pass 'domain' as Referer to trick the 530 error
                        const epHtml = await fetchShield(ajaxUrl, domain); 
                        
                        const $ep = cheerio.load(epHtml);
                        const episodes: any[] = [];
                        $ep('li').each((i, el) => {
                            const epId = $ep(el).find('a').attr('href')?.trim().replace('/', '');
                            const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                            if (epId) episodes.push({ id: epId, number: Number(epNum) });
                        });

                        if (episodes.length > 0) {
                            console.log(chalk.green(`      🎉 Connected to video server: ${ajaxBase}`));
                            return { id, title: id, episodes: episodes.reverse() };
                        }
                    } catch (e) {}
                }
            }
        }
        throw new Error("Gogo Info Failed (Proxy blocked)");
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

  // 🟢 ALL routes point to Gogo now.
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // If user clicks Pahe, force Gogo
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

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