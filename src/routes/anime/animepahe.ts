import { FastifyRequest, FastifyInstance, FastifyReply } from 'fastify';
import chalk from 'chalk';
import * as cheerio from 'cheerio';

const PROXIES = [
    "https://corsproxy.io/?",
    "https://api.codetabs.com/v1/proxy?quest=",
    "https://api.allorigins.win/raw?url="
];

// Helper to fetch using proxies
async function fetchShield(targetUrl: string, validationKeyword?: string) {
    // 1. Try Direct
    try {
        const res = await fetch(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Referer': 'https://gogoanimes.fi/',
            }
        });
        if (res.ok) {
            const text = await res.text();
            if (!validationKeyword || text.includes(validationKeyword)) return text;
        }
    } catch (e) {}

    // 2. Try Proxies
    for (const proxy of PROXIES) {
        try {
            const res = await fetch(`${proxy}${encodeURIComponent(targetUrl)}`);
            if (res.ok) {
                const text = await res.text();
                if (!validationKeyword || text.includes(validationKeyword)) return text;
            }
        } catch (e) {}
    }
    return "";
}

class CustomGogo {
    mirrors = ["https://anitaku.pe", "https://gogoanimes.fi", "https://gogoanime3.co"];
    
    // ... search logic remains same ...
    async search(query: string) { return this.internalSearch(query); }

    async internalSearch(query: string) {
        for (const domain of this.mirrors) {
            try {
                const searchUrl = `${domain}/search.html?keyword=${encodeURIComponent(query)}`;
                const html = await fetchShield(searchUrl, "last_episodes");
                if (!html) continue;

                const $ = cheerio.load(html);
                const results: any[] = [];
                $('.last_episodes ul li').each((i, el) => {
                    const title = $(el).find('.name a').text().trim();
                    const link = $(el).find('.name a').attr('href');
                    let img = $(el).find('.img a img').attr('src');
                    const releaseDate = $(el).find('.released').text().trim();
                    if (title && link) {
                        results.push({
                            id: link.replace('/category/', '').trim(), 
                            title: title,
                            image: img,
                            releaseDate: releaseDate
                        });
                    }
                });
                if (results.length > 0) return { results };
            } catch (e) {}
        }
        return { results: [] };
    }

    async fetchAnimeInfo(id: string) {
        console.log(chalk.blue(`   -> Gogo: Hunting for info on ${id}...`));
        let cleanId = id.replace(/-episode-\d+$/, '').replace(/-\d+$/, '');
        
        let foundInfo = await this.scrapeInfoPage(cleanId);
        
        if (!foundInfo && cleanId !== id) foundInfo = await this.scrapeInfoPage(id);
        
        if (!foundInfo) {
            console.log(chalk.yellow(`      Direct lookups failed. Searching...`));
            const searchData = await this.internalSearch(cleanId.replace(/-/g, " "));
            if (searchData.results && searchData.results.length > 0) {
                foundInfo = await this.scrapeInfoPage(searchData.results[0].id);
            }
        }

        if (foundInfo) return foundInfo;
        throw new Error("Gogo Info Failed");
    }

    async scrapeInfoPage(id: string) {
        for (const domain of this.mirrors) {
            try {
                const html = await fetchShield(`${domain}/category/${id}`, "anime_info_body_bg");
                if (!html) continue;

                const $ = cheerio.load(html);
                const movie_id = $('#movie_id').attr('value');
                const alias = $('#alias_anime').attr('value');
                const title = $('.anime_info_body_bg h1').text().trim();
                let image = $('.anime_info_body_bg img').attr('src');
                const desc = $('.anime_info_body_bg .description').text().trim();
                let ep_end = $('#episode_page a').last().attr('ep_end') || "2000";

                if (image && !image.startsWith('http')) image = `https://gogocdn.net${image}`;

                if (movie_id) {
                    console.log(chalk.green(`      ✅ Found movie_id: ${movie_id}`));
                    
                    // 🟢 EPISODE LIST FIX: Try multiple AJAX domains
                    const ajaxDomains = [
                        "https://ajax.gogo-load.com/ajax",
                        "https://ajax.gogocdn.net/ajax",
                        `${domain}/ajax`
                    ];

                    let listHtml = "";
                    for (const ajaxBase of ajaxDomains) {
                        const ajaxUrl = `${ajaxBase}/load-list-episode?ep_start=0&ep_end=${ep_end}&id=${movie_id}&default_ep=0&alias=${alias}`;
                        console.log(chalk.gray(`      Trying AJAX: ${ajaxBase}`));
                        listHtml = await fetchShield(ajaxUrl, "li");
                        if (listHtml) break; // Stop if we got the list
                    }

                    if (listHtml) {
                        const $ep = cheerio.load(listHtml);
                        const episodes: any[] = [];
                        $ep('li').each((i, el) => {
                            let epId = $ep(el).find('a').attr('href')?.trim() || "";
                            epId = epId.replace(/^\//, ''); 
                            const epNum = $ep(el).find('.name').text().replace('EP ', '').trim();
                            if (epId) episodes.push({ id: epId, number: Number(epNum) });
                        });
                        console.log(chalk.green(`      🎉 Found ${episodes.length} episodes`));
                        return { id, title, image, description: desc, episodes: episodes.reverse() };
                    }
                }
            } catch(e) {}
        }
        return null;
    }

    // ... fetchEpisodeSources remains the same (Proxy Tank) ...
    async fetchEpisodeSources(episodeId: string) {
        console.log(chalk.blue(`   -> Gogo: Fetching source for ${episodeId}...`));
        const downloadMirrors = [
            `https://anitaku.pe/download?id=${episodeId}`,
            `https://gogoanimes.fi/download?id=${episodeId}`
        ];
        for (const url of downloadMirrors) {
            const html = await fetchShield(url, "download");
            if (!html) continue;
            const $ = cheerio.load(html);
            let bestUrl = "";
            $('.mirror_link .dowload a, .dowload a').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim().toUpperCase();
                if (href && (text.includes("DOWNLOAD") || text.includes("MP4") || text.includes("HDP")) && href.startsWith("http")) {
                    if (!bestUrl || text.includes("1080")) bestUrl = href;
                }
            });
            if (bestUrl) return { sources: [{ url: bestUrl, quality: 'default', isM3U8: false }] };
        }
        const fallbackUrl = `https://embtaku.pro/streaming.php?id=${episodeId.split('-').pop()}`;
        return { sources: [{ url: fallbackUrl, quality: 'iframe', isM3U8: false }] };
    }
}

const customGogo = new CustomGogo();

const routes = async (fastify: FastifyInstance, options: any) => {
  const safeRun = async (providerName: string, fn: () => Promise<any>, reply: any) => {
    try {
        const res = await fn();
        return reply.send(res);
    } catch (e: any) {
        console.error(chalk.red(`Error:`), e.message);
        return reply.status(200).send({ error: e.message, results: [] });
    }
  };
  fastify.get('/gogo/search/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/gogo/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/gogo/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));
  // Default Routes
  fastify.get('/:query', (req: any, res) => safeRun('Gogo', () => customGogo.search(req.params.query), res));
  fastify.get('/info/:id', (req: any, res) => safeRun('Gogo', () => customGogo.fetchAnimeInfo(req.params.id), res));
  fastify.get('/watch/:episodeId', (req: any, res) => safeRun('Gogo', () => customGogo.fetchEpisodeSources(req.params.episodeId), res));
};

export default routes;