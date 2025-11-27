\
/*
Nyaomi v3 Ultimate - full bot
This file implements:
- :3 commands
- personalities
- per-server JSON storage
- auto-chatter every interval (default 10 min)
- multi-source feminine image fetching (Danbooru, waifu.pics, nekos.best)
- image pagination via buttons
- OpenAI optional integration
- Express health endpoint for Render
*/
import 'dotenv/config';
import express from 'express';
import fs from 'fs-extra';
import path from 'path';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ChannelType
} from 'discord.js';

// ---------- Setup & constants ----------
const DATA_DIR = path.resolve('./data');
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
await fs.ensureDir(DATA_DIR);
if (!await fs.pathExists(SERVERS_FILE)) await fs.writeJson(SERVERS_FILE, {});

function loadServers() { try { return fs.readJsonSync(SERVERS_FILE); } catch { return {}; } }
function saveServers(obj) { fs.writeJsonSync(SERVERS_FILE, obj, { spaces: 2 }); }

const serverConfigs = loadServers(); // persisted per-server
const memory = {}; // in-memory short-term per-channel
const imageCache = {}; // for pagination of :3image results
const DEFAULT_MEMORY_LENGTH = 10;
const AUTO_MIN_INTERVAL = 30; // seconds (safety minimum)
const EXPLICIT_KEYWORDS = ['porn','xxx','sex','rape','incest','gore','child','loli','shota','bestiality'];

// OpenAI (optional)
const OPENAI_KEY = process.env.OPENAI_API_KEY || null;
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

// ---------- Express health (for Render) ----------
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req,res) => res.send('Nyaomi is online~ nya! 💕'));
app.listen(PORT, () => console.log(`Health endpoint listening on port ${PORT}`));

// ---------- Discord client ----------
const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent ],
  partials: [ Partials.Channel ]
});

// ---------- Personality presets ----------
const PERSONALITIES = {
  cute: { name:'cute', desc:'Bubbly & sweet', systemPrompt:'You are Nyaomi: bubbly, playful, uses "nya~" and emoji. Keep replies cute & SFW.' },
  tsundere: { name:'tsundere', desc:'Teasing & flustered', systemPrompt:'You are Nyaomi: tsundere tone, lightly teasing but SFW.' },
  shy: { name:'shy', desc:'Soft & bashful', systemPrompt:'You are Nyaomi: shy, gentle and polite. SFW.' },
  chaotic: { name:'chaotic', desc:'Random & energetic', systemPrompt:'You are Nyaomi: chaotic and silly, SFW.' },
  caring: { name:'caring', desc:'Warm & comforting', systemPrompt:'You are Nyaomi: caring and supportive, SFW.' },
  flirty: { name:'flirty', desc:'Playful & teasing (SFW)', systemPrompt:'You are Nyaomi: playful, light teasing but never sexual. SFW.' }
};

// ---------- Utilities: server config & memory ----------
function getServerConfig(guildId) {
  if (!guildId) return { personality:'flirty', memoryLength: DEFAULT_MEMORY_LENGTH, auto: { enabled:false, channelId:null, intervalSec: parseInt(process.env.AUTO_CHAT_INTERVAL_SEC||'600',10) } };
  if (!serverConfigs[guildId]) {
    serverConfigs[guildId] = { personality:'flirty', memoryLength: DEFAULT_MEMORY_LENGTH, auto: { enabled:false, channelId:null, intervalSec: parseInt(process.env.AUTO_CHAT_INTERVAL_SEC||'600',10) } };
    saveServers(serverConfigs);
  }
  return serverConfigs[guildId];
}
function saveServer(guildId) {
  saveServers(serverConfigs);
}
function pushMemory(channelId, authorId, content) {
  if (!memory[channelId]) memory[channelId] = [];
  memory[channelId].push({ authorId, content, timestamp: Date.now() });
  if (memory[channelId].length > 200) memory[channelId] = memory[channelId].slice(-200);
}
function getContextMessages(channelId, guildId) {
  const cfg = getServerConfig(guildId);
  const memLen = (cfg.memoryLength !== undefined) ? cfg.memoryLength : DEFAULT_MEMORY_LENGTH;
  const arr = memory[channelId] || [];
  const sliced = arr.slice(-memLen);
  return sliced.map(m => ({ role: 'user', content: `${m.content}` }));
}
function textIsSafe(text) {
  if (!text) return false;
  const low = text.toLowerCase();
  for (const w of EXPLICIT_KEYWORDS) if (low.includes(w)) return false;
  return true;
}

// ---------- Catgirl flavor ----------
function catgirlTransform(text, personalityKey='flirty') {
  const suffixes = [' nya~', ' nya!', ' >w<', ' (✿◠‿◠)'];
  const emojis = ['😺','✨','🌸','🐾','💕'];
  const s = suffixes[Math.floor(Math.random()*suffixes.length)];
  const e = emojis[Math.floor(Math.random()*emojis.length)];
  if (personalityKey === 'tsundere') {
    return text.replace(/\?$/,'...').replace(/!$/, '... nya?') + s + ' ' + e;
  }
  return `${text}${s} ${e}`;
}

// ---------- Image sources (safe, feminine) ----------
async function fetchWaifuPics(endpoint='waifu') {
  try {
    const url = `https://api.waifu.pics/sfw/${endpoint}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('waifu.pics failed');
    const j = await r.json();
    if (j && j.url) return j.url;
  } catch (e) { /* ignore */ }
  return null;
}
async function fetchNekosBest(kind='neko') {
  try {
    const url = `https://nekos.best/api/v2/${kind}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error('nekos.best failed');
    const j = await r.json();
    if (j && j.results && j.results[0] && j.results[0].url) return j.results[0].url;
    if (j && j.url) return j.url;
  } catch (e) { /* ignore */ }
  return null;
}
async function searchDanbooru(tags, limit=3) {
  const safeTags = `${tags} rating:s order:score`;
  const encoded = encodeURIComponent(safeTags);
  const l = Math.min(5, Math.max(1, limit||3));
  const url = `https://danbooru.donmai.us/posts.json?tags=${encoded}&limit=${l}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'NyaomiBot/1.0 (safe search)' }});
  if (!r.ok) throw new Error('Danbooru request failed');
  const data = await r.json();
  const safe = (data||[]).filter(p => p.rating === 's' && (p.large_file_url || p.file_url || p.preview_file_url));
  return safe;
}
const FEMININE_SEED_TAGS = ['solo','neko','maid','school_uniform','long_hair','blush','smile','kimono','lolita','ribbons','flower'];

async function getRandomFeminineImage(suggestedTags=null) {
  const providers = [
    async () => {
      if (suggestedTags) {
        try {
          const posts = await searchDanbooru(suggestedTags, 3);
          if (posts && posts.length) return { url: posts[0].large_file_url || posts[0].file_url || posts[0].preview_file_url, source: `danbooru:${posts[0].id}`, post:posts[0] };
        } catch {}
      }
      return null;
    },
    async () => {
      const k = ['waifu','neko','smile','hug'][Math.floor(Math.random()*4)];
      const u = await fetchWaifuPics(k);
      if (u) return { url:u, source: 'waifu.pics' };
      return null;
    },
    async () => {
      const k = ['neko','blush'][Math.floor(Math.random()*2)];
      const u = await fetchNekosBest(k);
      if (u) return { url:u, source:'nekos.best' };
      return null;
    },
    async () => {
      const tags = Array.from({length: 2}, ()=> FEMININE_SEED_TAGS[Math.floor(Math.random()*FEMININE_SEED_TAGS.length)]).join(' ');
      try {
        const posts = await searchDanbooru(tags, 2);
        if (posts && posts.length) return { url: posts[0].large_file_url || posts[0].file_url || posts[0].preview_file_url, source: `danbooru:${posts[0].id}`, post:posts[0] };
      } catch {}
      return null;
    }
  ];

  for (let i = providers.length -1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [providers[i], providers[j]] = [providers[j], providers[i]];
  }

  for (const p of providers) {
    try {
      const res = await p();
      if (res) return res;
    } catch {}
  }
  return null;
}

// ---------- Web-sourced random fact (wikipedia or useless-facts fallback) ----------
async function fetchRandomFact() {
  try {
    const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/random/summary', { headers: { 'User-Agent': 'NyaomiBot/1.0 (safe random summaries)' }});
    if (r.ok) {
      const j = await r.json();
      const text = (j.title || '') + ': ' + (j.extract || '');
      if (textIsSafe(text)) return { title: j.title, text: j.extract, url: j.content_urls?.desktop?.page || null };
    }
  } catch (e) { /* ignore */ }

  try {
    const r = await fetch('https://useless-facts.sameerkumar.website/api/v2/facts/random');
    if (r.ok) {
      const j = await r.json();
      const txt = j.data || j.text || j.fact || '';
      if (textIsSafe(txt)) return { title:'Fun fact', text: txt, url: null };
    }
  } catch (e) { /* ignore */ }

  return { title: 'Cute fact', text: 'Cats sleep a lot — they are professional nappers!', url: null };
}

// ---------- Auto-chatter management ----------
const autoTimers = {}; // guildId -> intervalId

function startAutoForGuild(guildId) {
  const cfg = getServerConfig(guildId);
  if (!cfg || !cfg.auto?.enabled) return;
  const channelId = cfg.auto.channelId;
  const interval = Math.max(AUTO_MIN_INTERVAL, cfg.auto.intervalSec || parseInt(process.env.AUTO_CHAT_INTERVAL_SEC || '600',10));
  if (!channelId) return;
  if (autoTimers[guildId]) clearInterval(autoTimers[guildId]);

  const doPost = async () => {
    try {
      const guild = await client.guilds.fetch(guildId).catch(()=>null);
      if (!guild) return;
      const channel = await client.channels.fetch(channelId).catch(()=>null);
      if (!channel || channel.type !== ChannelType.GuildText) return;

      const fact = await fetchRandomFact();
      const suggestedTags = fact.title ? fact.title.split(/\s+/).slice(0,3).join(' ') : null;
      let image = await getRandomFeminineImage(suggestedTags);

      const cfgServer = getServerConfig(guildId);
      let crafted = '';
      try {
        if (openai) {
          const messages = [
            { role:'system', content: PERSONALITIES[cfgServer.personality]?.systemPrompt || PERSONALITIES.flirty.systemPrompt },
            { role:'user', content: `Create a short (1-2 sentence), playful, SFW catgirl-style message introducing this fact. Title: ${fact.title}. Summary: ${fact.text}. Keep it charming and end with 'nya~'.` }
          ];
          const resp = await openai.chat.completions.create({ model:'gpt-4o-mini', messages, max_tokens:140, temperature:0.9 });
          crafted = resp.choices?.[0]?.message?.content?.trim() || resp.choices?.[0]?.text || '';
        }
      } catch (err) {
        crafted = '';
      }
      if (!crafted) crafted = catgirlTransform(`Did you know? ${fact.title}: ${fact.text.slice(0,180)}${fact.text.length>180 ? '...' : ''}`, cfgServer.personality);

      const embed = new EmbedBuilder().setTitle(fact.title || 'Fun thing').setDescription((fact.text || '').slice(0,400) + (fact.url ? `\n\n[Read more](${fact.url})` : '')).setFooter({ text: "Nyaomi's tidbit" });
      if (image && image.url) {
        embed.setImage(image.url);
        await channel.send({ content: crafted, embeds: [embed] }).catch(()=>null);
      } else {
        await channel.send({ content: crafted, embeds: [embed] }).catch(()=>null);
      }
    } catch (err) {
      console.error('Auto-chatter post error', err);
    }
  };

  doPost();
  autoTimers[guildId] = setInterval(doPost, interval * 1000);
}

function stopAutoForGuild(guildId) {
  if (autoTimers[guildId]) { clearInterval(autoTimers[guildId]); delete autoTimers[guildId]; }
}

// initialize auto for servers that had it enabled
for (const gid of Object.keys(serverConfigs)) {
  if (serverConfigs[gid]?.auto?.enabled) startAutoForGuild(gid);
}

// ---------- :3 command parsing ----------
const PREFIX = ':3';

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const cfg = getServerConfig(message.guildId);
  const memLen = (cfg.memoryLength !== undefined) ? cfg.memoryLength : DEFAULT_MEMORY_LENGTH;
  if (memLen > 0) {
    pushMemory(message.channelId, message.author.id, message.content);
  }

  if (message.mentions.has(client.user)) {
    try {
      const context = getContextMessages(message.channelId, message.guildId);
      const clean = message.content.replace(`<@!${client.user.id}>`, '').replace(`<@${client.user.id}>`, '').trim();
      const reply = await generateReply(clean || 'hiya!', cfg.personality, context);
      pushMemory(message.channelId, client.user.id, reply);
      message.reply(reply).catch(()=>null);
    } catch (err) {
      console.error('Mention reply error', err);
    }
  }

  if (!message.content.startsWith(PREFIX)) return;

  const raw = message.content.slice(PREFIX.length).trim();
  const args = raw.split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();

  if (cmd === 'chat') {
    const text = args.join(' ');
    if (!text) return message.reply(catgirlTransform("Say something, nya~"));
    const context = getContextMessages(message.channelId, message.guildId);
    const reply = await generateReply(text, getServerConfig(message.guildId).personality, context);
    pushMemory(message.channelId, message.author.id, text);
    pushMemory(message.channelId, client.user.id, reply);
    return message.reply(reply).catch(()=>null);
  }

  if (cmd === 'image') {
    const limitArgIndex = args.findIndex(a => /^\d+$/.test(a));
    let limit = 3;
    if (limitArgIndex >= 0) {
      limit = Math.min(5, Math.max(1, parseInt(args[limitArgIndex],10)));
      args.splice(limitArgIndex,1);
    }
    const tags = args.join(' ').trim();
    if (!tags) return message.reply(catgirlTransform('Please give me some tags to search, nya~ e.g. :3image neko maid'));

    const low = tags.toLowerCase();
    for (const f of ['rating:explicit','rating:questionable','explicit','nsfw','loli','shota','rape','incest']) {
      if (low.includes(f)) return message.reply('I only fetch SFW images (rating:s). Please remove adult or explicit tags.');
    }

    let results = [];
    try { results = await searchDanbooru(tags, limit); } catch (e) { console.warn('Danbooru error', e); }

    if (!results.length) {
      const fallbackImage = await getRandomFeminineImage();
      if (fallbackImage && fallbackImage.url) {
        const em = new EmbedBuilder().setTitle(`Nyaomi's pick`).setImage(fallbackImage.url).setDescription(`No direct Danbooru results for "${tags}", but here's something cute.`).setFooter({ text: fallbackImage.source });
        return message.reply({ content: catgirlTransform('I couldn\\'t find exact Danbooru results, but I found this!'), embeds: [em] }).catch(()=>null);
      }
      return message.reply(catgirlTransform(`I couldn't find safe images for "${tags}", maybe try different tags?`)).catch(()=>null);
    }

    const cacheKey = `imgcache:${message.id}:${Date.now()}`;
    imageCache[cacheKey] = { results, index:0, author: message.author.id };
    const post = results[0];
    const imageUrl = post.large_file_url || post.file_url || post.preview_file_url;
    const embed = new EmbedBuilder().setTitle(`Danbooru: ${post.tag_string}`).setURL(`https://danbooru.donmai.us/posts/${post.id}`).setImage(imageUrl).setFooter({ text: `Nyaomi's pick • Score: ${post.score || 0}` });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`img_prev:${cacheKey}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`img_next:${cacheKey}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
    );

    await message.reply({ content: catgirlTransform(`Found ${results.length} safe image(s) for "${tags}" — use buttons to browse!`, getServerConfig(message.guildId).personality), embeds: [embed], components: [row] });
    setTimeout(()=>{ delete imageCache[cacheKey]; }, 10*60*1000);
    return;
  }

  if (cmd === 'personality') {
    const sub = args[0]?.toLowerCase();
    const cfg = getServerConfig(message.guildId);
    if (!sub || sub === 'get') return message.reply(`Current personality: **${cfg.personality}**`).catch(()=>null);
    if (sub === 'list') {
      const list = Object.values(PERSONALITIES).map(p => `${p.name} — ${p.desc}`).join('\n');
      return message.reply(catgirlTransform(`Available personalities:\n${list}`, cfg.personality)).catch(()=>null);
    }
    if (sub === 'set' && args[1]) {
      const val = args[1].toLowerCase();
      if (!PERSONALITIES[val]) return message.reply('Unknown personality. Use :3personality list').catch(()=>null);
      cfg.personality = val;
      saveServer(message.guildId);
      return message.reply(catgirlTransform(`Personality set to **${val}**!`, cfg.personality)).catch(()=>null);
    }
    const val = sub;
    if (PERSONALITIES[val]) {
      cfg.personality = val;
      saveServer(message.guildId);
      return message.reply(catgirlTransform(`Personality set to **${val}**!`, cfg.personality)).catch(()=>null);
    }
    return message.reply('Usage: :3personality set|get|list OR :3personality <name>').catch(()=>null);
  }

  if (cmd === 'status') {
    const cfg = getServerConfig(message.guildId);
    const next = cfg.auto?.enabled ? `Auto on in <#${cfg.auto.channelId}> every ${cfg.auto.intervalSec}s` : 'Auto off';
    return message.reply(catgirlTransform(`Server personality: **${cfg.personality}**\n${next}`, cfg.personality)).catch(()=>null);
  }

  if (cmd === 'auto') {
    const sub = args[0]?.toLowerCase();
    const cfg = getServerConfig(message.guildId);
    if (sub === 'enable') {
      let channel = message.mentions.channels.first() || message.channel;
      if (channel.type !== ChannelType.GuildText) return message.reply('Please provide a text channel.').catch(()=>null);
      cfg.auto.enabled = true;
      cfg.auto.channelId = channel.id;
      cfg.auto.intervalSec = Math.max(AUTO_MIN_INTERVAL, cfg.auto.intervalSec || parseInt(process.env.AUTO_CHAT_INTERVAL_SEC||'600',10));
      saveServer(message.guildId);
      startAutoForGuild(message.guildId);
      return message.reply(catgirlTransform(`Auto-chatter enabled in <#${channel.id}> every ${cfg.auto.intervalSec}s`, cfg.personality)).catch(()=>null);
    }
    if (sub === 'disable') {
      cfg.auto.enabled = false;
      saveServer(message.guildId);
      stopAutoForGuild(message.guildId);
      return message.reply(catgirlTransform('Auto-chatter disabled, nya~', cfg.personality)).catch(()=>null);
    }
    if (sub === 'setinterval') {
      const sec = parseInt(args[1],10);
      if (!sec || sec < AUTO_MIN_INTERVAL) return message.reply(`Provide seconds >= ${AUTO_MIN_INTERVAL}`).catch(()=>null);
      cfg.auto.intervalSec = sec;
      saveServer(message.guildId);
      if (cfg.auto.enabled) { stopAutoForGuild(message.guildId); startAutoForGuild(message.guildId); }
      return message.reply(catgirlTransform(`Auto interval set to ${sec} seconds`, cfg.personality)).catch(()=>null);
    }
    return message.reply('Usage: :3auto enable|disable|setinterval <seconds>').catch(()=>null);
  }

  if (cmd === 'memory') {
    const sub = args[0]?.toLowerCase();
    const cfg = getServerConfig(message.guildId);
    if (sub === 'get' || !sub) return message.reply(`Memory length: ${cfg.memoryLength || DEFAULT_MEMORY_LENGTH}`).catch(()=>null);
    if (sub === 'set') {
      const n = parseInt(args[1],10);
      if (isNaN(n) || n < 0 || n > 50) return message.reply('Provide 0-50').catch(()=>null);
      cfg.memoryLength = n;
      saveServer(message.guildId);
      return message.reply(catgirlTransform(`Memory set to ${n} messages per channel`, cfg.personality)).catch(()=>null);
    }
    return message.reply('Usage: :3memory get|set <count>').catch(()=>null);
  }

  return message.reply(catgirlTransform("I don't know that command, nya~ Try :3personality list or :3image neko")).catch(()=>null);
});

// ---------- button interactions (image pagination) ----------
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;
  try {
    const id = i.customId;
    if (id.startsWith('img_prev:') || id.startsWith('img_next:')) {
      const parts = id.split(':');
      const action = parts[0].startsWith('img_prev') ? 'prev' : 'next';
      const cacheKey = parts[1];
      const cache = imageCache[cacheKey];
      if (!cache) {
        await i.reply({ content: 'Session expired or not found.', ephemeral: true });
        return;
      }
      const len = cache.results.length;
      if (action === 'next') cache.index = (cache.index + 1) % len;
      else cache.index = (cache.index - 1 + len) % len;
      const post = cache.results[cache.index];
      const embed = new EmbedBuilder()
        .setTitle(`Danbooru: ${post.tag_string}`)
        .setURL(`https://danbooru.donmai.us/posts/${post.id}`)
        .setImage(post.large_file_url || post.file_url || post.preview_file_url)
        .setFooter({ text: `Nyaomi's pick • ${cache.index+1}/${len} • Score: ${post.score||0}` });
      await i.update({ embeds: [embed] });
    }
  } catch (err) {
    console.error('Button handling error:', err);
    try { await i.reply({ content: 'Error handling button.', ephemeral: true }); } catch(e){}
  }
});

// ---------- helper: generate reply (OpenAI optional, fallback local) ----------
async function generateReply(userText, personality='flirty', context=[]) {
  if (openai) {
    try {
      const system = PERSONALITIES[personality]?.systemPrompt || PERSONALITIES.flirty.systemPrompt;
      const messages = [{ role:'system', content: system }, ...context, { role:'user', content: userText }];
      const resp = await openai.chat.completions.create({ model:'gpt-4o-mini', messages, max_tokens:150, temperature:0.9 });
      const out = resp.choices?.[0]?.message?.content || resp.choices?.[0]?.text || '';
      return catgirlTransform(out.trim(), personality);
    } catch (e) { console.warn('OpenAI reply failed', e); }
  }
  const templates = {
    flirty: ['Heehee, I found something special for you!', 'Nyaa~ like this~?'],
    cute: ['Ooh! How adorable!', 'Aww, that makes me so happy~'],
    tsundere: ["I-I'm not impressed or anything, baka!", "Hmph. Fine. You're welcome."],
    shy: ['U-um... thanks... *blush*', 'I hope that helps...'],
    chaotic: ['WOO! SPARKLES & PIZZA!', 'Everything is fun, nya~'],
    caring: ['There there~ I\'m here for you.', 'You can tell me anything, nyaa']
  };
  const pick = templates[personality] || templates.flirty;
  return catgirlTransform(pick[Math.floor(Math.random()*pick.length)] + (userText ? ` (${userText.slice(0,80)})` : ''), personality);
}

// ---------- ready & login ----------
client.once('ready', () => {
  console.log(`Nyaomi online as ${client.user.tag}`);
  for (const gid of Object.keys(serverConfigs)) {
    if (serverConfigs[gid]?.auto?.enabled) startAutoForGuild(gid);
  }
});
client.login(process.env.DISCORD_TOKEN);

// ---------- graceful shutdown ----------
process.on('SIGINT', ()=>{ console.log('Shutting down'); process.exit(0); });
process.on('SIGTERM', ()=>{ console.log('Shutting down'); process.exit(0); });
