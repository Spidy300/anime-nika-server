import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

const PROXY_URL = "https://anime-proxyc.sudeepb9880.workers.dev"; 

async function fetchShield(targetUrl: string, referer?: string) {
    let fullUrl = `${PROXY_URL}?url=${encodeURIComponent(targetUrl)}`;
    fullUrl += `&headers=${encodeURIComponent(JSON.stringify({
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
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

                // 🟢 STRATEGY: MULTI-SERVER SWEEP
                // Collect ALL available servers for this episode
                const players: { name: string, url: string }[] = [];

                // 1. Vidstreaming (Default)
                const vidcdn = $('li.vidcdn a').attr('data-video');
                if (vidcdn) players.push({ name: 'Vidstreaming', url: vidcdn });

                // 2. StreamSB (Very Reliable Backup)
                const streamsb = $('li.streamsb a').attr('data-video');
                if (streamsb) players.push({ name: 'StreamSB', url: streamsb });

                // 3. Xstream (Backup)
                const xstream = $('li.xstreamcdn a').attr('data-video');
                if (xstream) players.push({ name: 'Xstream', url: xstream });

                // 4. Default Iframe (Fallback)
                const defaultFrame = $('iframe').first().attr('src');
                if (defaultFrame) players.push({ name: 'Default', url: defaultFrame });

                // 🟢 EXECUTE SWEEP
                for (let player of players) {
                    let url = player.url;
                    if (url.startsWith('//')) url = 'https:' + url;
                    
                    console.log(chalk.gray(`      Scanning Server: [${player.name}] ${url}`));

                    try {
                        const playerHtml = await fetchShield(url, domain);

                        // 🔍 Check 1: M3U8 (Standard)
                        const m3u8Match = playerHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
                        if (m3u8Match && m3u8Match[1]) {
                            console.log(chalk.green(`      🎉 FOUND VIDEO on ${player.name}: ${m3u8Match[1]}`));
                            return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                        }

                        // 🔍 Check 2: MP4 (StreamSB/Legacy)
                        const mp4Match = playerHtml.match(/file:\s*['"](https?:\/\/[^"']+\.mp4)['"]/);
                        if (mp4Match && mp4Match[1]) {
                             console.log(chalk.green(`      🎉 FOUND MP4 on ${player.name}: ${mp4Match[1]}`));
                             return { sources: [{ url: mp4Match[1], quality: 'default', isM3U8: false }] };
                        }

                        // 🔍 Check 3: JWPlayer Config
                        const jwMatch = playerHtml.match(/sources:\s*(\[\{.*?\}\])/s);
                        if (jwMatch && jwMatch[1]) {
                             const fileMatch = jwMatch[1].match(/file:\s*['"]([^'"]+)['"]/);
                             if (fileMatch && fileMatch[1]) {
                                 console.log(chalk.green(`      🎉 FOUND JWPLAYER on ${player.name}: ${fileMatch[1]}`));
                                 return { sources: [{ url: fileMatch[1], quality: 'default', isM3U8: fileMatch[1].includes('.m3u8') }] };
                             }
                        }

                    } catch (err) {
                        // console.log(`      ⚠️ ${player.name} failed, trying next...`);
                    }
                }

            } catch(e) {}
        }
        
        throw new Error("Gogo Watch Failed - All servers exhausted");
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

  // Default
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        if (url.includes('.php') || url.includes('.html')) return reply.status(400).send("Invalid Video URL");

        const fullUrl = `${PROXY_URL}?url=${encodeURIComponent(url)}`;
        const response = await fetch(fullUrl);
        reply.header("Access-Control-Allow-Origin", "*");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;