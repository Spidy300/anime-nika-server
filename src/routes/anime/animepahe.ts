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
    // 🟢 UPDATED MIRRORS: Added new working domains
    mirrors = ["https://anitaku.pe", "https://gogoanimes.fi", "https://gogoanime3.co"];
    
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

                // 🟢 STRATEGY 1: BRUTE FORCE IFRAME FINDER
                // Find ANY iframe on the page. We don't care about class names anymore.
                let iframeUrl = "";
                $('iframe').each((i, el) => {
                    const src = $(el).attr('src');
                    // We only want video player iframes, usually they contain 'streaming', 'embed', or 'vid'
                    if (src && (src.includes('streaming') || src.includes('embed') || src.includes('vid'))) {
                        iframeUrl = src;
                        return false; 
                    }
                });

                if (iframeUrl) {
                    if (iframeUrl.startsWith('//')) iframeUrl = 'https:' + iframeUrl;
                    console.log(chalk.green(`      Found Player: ${iframeUrl}`));

                    // 🟢 STRATEGY 2: THE URL HACK
                    // Convert the streaming URL directly to the download URL.
                    // Example: streaming.php?id=X -> download?id=X
                    // This bypasses the player's security entirely.
                    if (iframeUrl.includes('streaming.php') || iframeUrl.includes('embed.php') || iframeUrl.includes('load.php')) {
                        const downloadUrl = iframeUrl.replace(/(streaming|embed|load)\.php/, 'download');
                        console.log(chalk.green(`      ⚡ Hacking URL to: ${downloadUrl}`));
                        
                        try {
                            const dlHtml = await fetchShield(downloadUrl, domain);
                            const $dl = cheerio.load(dlHtml);
                            
                            let bestMp4 = "";
                            $dl('a').each((i, el) => {
                                const href = $dl(el).attr('href');
                                const text = $dl(el).text().toUpperCase();
                                if (href && (text.includes('1080') || text.includes('720') || text.includes('P'))) {
                                    bestMp4 = href;
                                }
                            });

                            if (bestMp4) {
                                console.log(chalk.green(`      🎉 HACK SUCCESS: ${bestMp4}`));
                                return { sources: [{ url: bestMp4, quality: 'default', isM3U8: false }] };
                            }
                        } catch(e) {
                            console.log(chalk.yellow(`      ⚠️ Hack failed: ${e}`));
                        }
                    }

                    // 🟢 STRATEGY 3: DEEP SCAN (Backup)
                    console.log(chalk.gray("      Falling back to standard scan..."));
                    const playerHtml = await fetchShield(iframeUrl, domain);
                    
                    // Super aggressive regex that catches almost anything resembling a video link
                    const m3u8Match = playerHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
                    if (m3u8Match && m3u8Match[1]) {
                        console.log(chalk.green(`      🎉 EXTRACTED M3U8: ${m3u8Match[1]}`));
                        return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                    }
                }

            } catch(e) {}
        }
        
        throw new Error("Gogo Watch Failed - All strategies exhausted");
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