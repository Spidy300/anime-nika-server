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
        return "";
    }
}

class CustomGogo {
    mirrors = ["https://gogoanimes.fi", "https://anitaku.pe", "https://gogoanime3.co"];
    
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
            const html = await fetchShield(`${domain}/category/${id}`);
            if (!html || html.includes("WAF") || html.includes("Verify")) continue;

            const $ = cheerio.load(html);
            const movie_id = $('#movie_id').attr('value');
            const alias = $('#alias_anime').attr('value');
            let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

            if (movie_id) {
                console.log(chalk.green(`      ✅ Found movie_id: ${movie_id} on ${domain}`));
                
                const ajaxStrategies = [
                    `${domain}/ajax/load-list-episode`, 
                    "https://ajax.gogo-load.com/ajax/load-list-episode",
                    "https://ajax.gogocdn.net/ajax/load-list-episode"
                ];

                for (const ajaxBase of ajaxStrategies) {
                    try {
                        const ajaxUrl = `${ajaxBase}?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                        const epHtml = await fetchShield(ajaxUrl, domain); 
                        
                        if (epHtml.includes("Redirecting")) continue;

                        const $ep = cheerio.load(epHtml);
                        const episodes: any[] = [];
                        
                        $ep('li').each((i, el) => {
                            let epId = $ep(el).find('a').attr('href')?.trim() || "";
                            epId = epId.replace(/^\//, '');
                            if (epId.startsWith('-') || (id && !epId.includes(id))) {
                                const suffix = epId.replace(/^-+/, ''); 
                                epId = `${id}-${suffix}`;
                            }
                            const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                            if (epId) episodes.push({ id: epId, number: Number(epNum) });
                        });

                        if (episodes.length > 0) {
                            console.log(chalk.green(`      🎉 Success: Connected to ${ajaxBase} (${episodes.length} eps)`));
                            return { id, title: id, episodes: episodes.reverse() };
                        }
                    } catch (e) {}
                }
            }
        }
        throw new Error("Gogo Info Failed");
    }

    async fetchEpisodeSources(episodeId: string) {
        console.log(chalk.blue(`   -> Gogo: Fetching source for ${episodeId}...`));
        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/${episodeId}`);
                if (!html) continue;

                const $ = cheerio.load(html);
                
                // 🟢 NEW STRATEGY: Find the "Vidstreaming" (vidcdn) server explicitly
                // This is much more reliable than the default iframe
                let iframe = $('.anime_muti_link ul li.vidcdn a').attr('data-video');
                
                // Fallback to default if vidcdn is missing
                if (!iframe) iframe = $('iframe').first().attr('src');

                if (iframe) {
                    if (iframe.startsWith('//')) iframe = 'https:' + iframe;
                    console.log(chalk.green(`      Targeting Iframe: ${iframe}`));

                    try {
                        const playerHtml = await fetchShield(iframe, domain);
                        
                        // 1. JWPlayer Sources Regex (Most common for Vidstreaming)
                        const jwMatch = playerHtml.match(/sources:\s*(\[\{.*?\}\])/s);
                        if (jwMatch && jwMatch[1]) {
                            const fileMatch = jwMatch[1].match(/file:\s*['"]([^'"]+)['"]/);
                            if (fileMatch && fileMatch[1]) {
                                console.log(chalk.green(`      🎉 JWPLAYER EXTRACT: ${fileMatch[1]}`));
                                return { sources: [{ url: fileMatch[1], quality: 'default', isM3U8: true }] };
                            }
                        }

                        // 2. Generic M3U8 Regex (Backup)
                        const m3u8Match = playerHtml.match(/(https?:\/\/[^"']+\.m3u8)/);
                        if (m3u8Match && m3u8Match[1]) {
                             console.log(chalk.green(`      🎉 GENERIC EXTRACT: ${m3u8Match[1]}`));
                             return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                        }
                        
                        console.log(chalk.yellow(`      ⚠️ Extraction failed. Snippet: ${playerHtml.substring(0, 100)}`));

                    } catch(err) {
                        console.log(chalk.red(`      ⚠️ Extraction error: ${err}`));
                    }

                    // Fallback
                    return { sources: [{ url: iframe, quality: 'default', isM3U8: false }] };
                }
            } catch(e) {}
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

  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

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