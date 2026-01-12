import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// Keep your worker proxy
const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    
    // Mimic a standard browser to avoid basic blocks
    fullUrl += `&headers=${encodeURIComponent(JSON.stringify({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer || 'https://gogoanimes.fi/'
    }))}`;
    
    try {
        const res = await fetch(fullUrl);
        if (!res.ok) throw new Error(`Shield Status: ${res.status}`);
        return await res.text();
    } catch (e) {
        return "";
    }
}

class CustomGogo {
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

                // 🟢 STEP 1: EXTRACT THE RAW ID
                // We don't want the full URL yet, we just want the ID of the video (e.g. "MTIzNDU=")
                // It's usually inside the iframe src URL: .../streaming.php?id=MTIzNDU=&...
                let iframeSrc = $('iframe').first().attr('src') || "";
                
                // Also check specific buttons for the ID
                const vidcdnSrc = $('li.vidcdn a').attr('data-video');
                if (vidcdnSrc) iframeSrc = vidcdnSrc;

                // Extract the ID parameter
                const idMatch = iframeSrc.match(/[?&]id=([^&]+)/);
                
                if (idMatch && idMatch[1]) {
                    const cleanId = idMatch[1];
                    console.log(chalk.green(`      Found Video ID: ${cleanId}`));

                    // 🟢 STEP 2: CONSTRUCT THE EMBTAKU URL
                    // Instead of using the weird Gogo player, we go straight to the source
                    const embtakuUrl = `https://embtaku.pro/streaming.php?id=${cleanId}`;
                    console.log(chalk.gray(`      Force-Switching to: ${embtakuUrl}`));

                    // 🟢 STEP 3: SCRAPE EMBTAKU
                    try {
                        const playerHtml = await fetchShield(embtakuUrl, domain);
                        
                        // Look for the "file": "..." pattern
                        const fileMatch = playerHtml.match(/file:\s*['"]([^'"]+\.m3u8)['"]/);
                        
                        if (fileMatch && fileMatch[1]) {
                            console.log(chalk.green(`      🎉 EXTRACTED M3U8: ${fileMatch[1]}`));
                            return { sources: [{ url: fileMatch[1], quality: 'default', isM3U8: true }] };
                        }
                        
                        // Backup: Look for JWPlayer setup
                        const jwMatch = playerHtml.match(/sources:\s*(\[\{.*?\}\])/s);
                        if (jwMatch && jwMatch[1]) {
                             const jwFile = jwMatch[1].match(/file:\s*['"]([^'"]+)['"]/);
                             if (jwFile && jwFile[1]) {
                                 console.log(chalk.green(`      🎉 EXTRACTED JWPLAYER: ${jwFile[1]}`));
                                 return { sources: [{ url: jwFile[1], quality: 'default', isM3U8: true }] };
                             }
                        }

                        // 🟢 STEP 4: IFRAME FALLBACK
                        // If we can't extract the link, return the cleaned Embtaku URL.
                        // Many players CAN play this URL directly because it's a standard embed.
                        console.log(chalk.yellow("      ⚠️ Extraction failed, returning clean Embed URL."));
                        return { sources: [{ url: embtakuUrl, quality: 'iframe', isM3U8: false }] };

                    } catch(err) {
                        console.log(chalk.red(`      ⚠️ Embtaku Error: ${err}`));
                    }
                }
            } catch(e) {}
        }
        
        throw new Error("Gogo Watch Failed - Could not find video ID");
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

  // Catch-all
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