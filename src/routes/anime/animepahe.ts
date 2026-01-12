import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

// 🟢 NEW PROXY LIST (The Tunnel)
const PROXIES = [
    "https://corsproxy.io/?", 
    "https://api.allorigins.win/raw?url=", 
    "https://api.codetabs.com/v1/proxy?quest="
];

async function fetchShield(targetUrl: string, referer?: string) {
    // 1. Try Direct Connection (Fastest)
    try {
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
                'Referer': referer || 'https://gogoanimes.fi/'
            }
        });
        if (res.ok) return await res.text();
    } catch (e) {}

    // 2. Try Proxy Tunnels (If blocked)
    for (const proxy of PROXIES) {
        try {
            console.log(chalk.gray(`      🛡️ Tunneling via: ${proxy}`));
            const res = await fetch(`${proxy}${encodeURIComponent(targetUrl)}`);
            if (res.ok) return await res.text();
        } catch (e) {}
    }
    
    return "";
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

                // 🟢 STRATEGY: SCAN ALL PLAYERS (Vidstreaming, StreamSB, etc)
                const players: string[] = [];
                
                // Collect specific server links
                $('li.vidcdn a, li.streamsb a, li.xstreamcdn a').each((i, el) => {
                    const url = $(el).attr('data-video');
                    if (url) players.push(url);
                });
                
                // Fallback to default iframe
                const defaultFrame = $('iframe').first().attr('src');
                if (defaultFrame) players.push(defaultFrame);

                // Remove duplicates and fix protocol
                const uniquePlayers = [...new Set(players)].map(url => url.startsWith('//') ? 'https:' + url : url);

                for (const playerUrl of uniquePlayers) {
                    console.log(chalk.gray(`      Scanning Player: ${playerUrl}`));

                    try {
                        const playerHtml = await fetchShield(playerUrl, domain);
                        
                        // 1. M3U8 Regex
                        const m3u8Match = playerHtml.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/);
                        if (m3u8Match && m3u8Match[1]) {
                            console.log(chalk.green(`      🎉 FOUND M3U8: ${m3u8Match[1]}`));
                            return { sources: [{ url: m3u8Match[1], quality: 'default', isM3U8: true }] };
                        }

                        // 2. MP4 Regex (Legacy/StreamSB)
                        const mp4Match = playerHtml.match(/file:\s*['"](https?:\/\/[^"']+\.mp4)['"]/);
                        if (mp4Match && mp4Match[1]) {
                             console.log(chalk.green(`      🎉 FOUND MP4: ${mp4Match[1]}`));
                             return { sources: [{ url: mp4Match[1], quality: 'default', isM3U8: false }] };
                        }
                    } catch (err) {}
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

  // Default routes
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));

  // Proxy Endpoint
  fastify.get('/proxy', async (req: any, reply: FastifyReply) => {
    try {
        const { url } = req.query;
        if (!url) return reply.status(400).send("Missing URL");
        // Block HTML/PHP to prevent playing error pages
        if (url.includes('.php') || url.includes('.html')) return reply.status(400).send("Invalid Video");

        const response = await fetch(url);
        reply.header("Access-Control-Allow-Origin", "*");
        reply.send(Buffer.from(await response.arrayBuffer()));
    } catch (e) { reply.status(500).send({ error: "Proxy Error" }); }
  });
};

export default routes;