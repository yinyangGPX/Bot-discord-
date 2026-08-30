require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  AttachmentBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits
} = require('discord.js');

const {
  createCanvas,
  loadImage,
  GlobalFonts
} = require('@napi-rs/canvas');

const os   = require('os');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Fuentes ──────────────────────────────────────────────────────────────────
async function loadFonts() {
  // ── Inter (UI pequeño) ────────────────────────────────────────────────────
  const fontUrl  = 'https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiA.woff2';
  const fontPath = path.join(os.tmpdir(), 'Inter-Bold.woff2');
  if (!fs.existsSync(fontPath)) {
    const res = await fetch(fontUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(fontPath, buf);
  }
  GlobalFonts.registerFromPath(fontPath, 'Inter');
  console.log('✅ Fuente Inter registrada');

  // ── Bebas Neue (display — welcome card) ───────────────────────────────────
  const bebasUrl  = 'https://fonts.gstatic.com/s/bebasneue/v21/JTUSjIg69CK48gW7PXoo9WdhyyTh89ZNpQ.woff2';
  const bebasPath = path.join(os.tmpdir(), 'BebasNeue.woff2');
  if (!fs.existsSync(bebasPath)) {
    const res2 = await fetch(bebasUrl);
    const buf2 = Buffer.from(await res2.arrayBuffer());
    fs.writeFileSync(bebasPath, buf2);
  }
  GlobalFonts.registerFromPath(bebasPath, 'BebasNeue');
  console.log('✅ Fuente BebasNeue registrada');
}

// ── Variables de entorno ─────────────────────────────────────────────────────
const TOKEN              = process.env.TOKEN;
const CLIENT_ID          = process.env.CLIENT_ID;
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID;

if (!TOKEN)              { console.error('Falta TOKEN.');              process.exit(1); }
if (!CLIENT_ID)          { console.error('Falta CLIENT_ID.');          process.exit(1); }
if (!WELCOME_CHANNEL_ID) { console.error('Falta WELCOME_CHANNEL_ID.'); process.exit(1); }

// ── Guard anti-duplicados ───────────────────────────────────────────────────
// Si por cualquier motivo (dos procesos vivos, reconexión del gateway, etc.)
// el mismo evento llega dos veces, esto lo detecta y descarta la repetición
// sin importar la causa real detrás.
const processedMemberJoins = new Set();
const processedMessageIds  = new Set();
function markProcessed(set, key, ttlMs = 15000) {
  if (set.has(key)) return false; // ya se procesó — es un duplicado
  set.add(key);
  setTimeout(() => set.delete(key), ttlMs);
  return true;
}

// ── Idempotencia nativa de Discord ─────────────────────────────────────────
// Discord rechaza dos mensajes creados con el mismo nonce cuando enforceNonce
// está activo. La clave se deriva del evento lógico, no del proceso, por lo que
// también protege si dos instancias reciben el mismo evento simultáneamente.
function messageNonce(...parts) {
  return crypto.createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 25);
}
function withMessageNonce(payload, ...parts) {
  return { ...payload, nonce: messageNonce(...parts), enforceNonce: true };
}

// ── Deduplicación real (contra Discord, no contra memoria del proceso) ────────
// El Set de arriba solo protege DENTRO de un mismo proceso. Si hubiera más de
// un proceso vivo (zombie de un deploy viejo, etc.), cada uno manda su propia
// tarjeta sin saber del otro. Esto en cambio mira los mensajes reales del canal
// (que ambos procesos ven igual) y borra las tarjetas propias repetidas que
// mencionan al mismo usuario dentro de los últimos 30s, quedándose con la más vieja.
const DEDUPE_WINDOW_MS = 30000;
async function deduplicateOwnMention(channel, userId) {
  try {
    const recent = await channel.messages.fetch({ limit: 30 });
    const now    = Date.now();
    const dupes  = recent.filter(m =>
      m.author.id === client.user.id &&
      m.content.includes(`<@${userId}>`) &&
      (now - m.createdTimestamp) <= DEDUPE_WINDOW_MS
    );
    if (dupes.size <= 1) return;
    const sorted = [...dupes.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (let i = 1; i < sorted.length; i++) {
      await sorted[i].delete().catch(() => {});
    }
  } catch (err) {
    console.error('Error deduplicando mensajes propios:', err);
  }
}

// ── Bienvenida idempotente ────────────────────────────────────────────────────
// El Set local cubre un único proceso. Estas comprobaciones adicionales cubren
// carreras entre procesos y reentregas del gateway.
const WELCOME_DEDUPE_WINDOW_MS = 30000;
function isOwnWelcomeMessage(message, userId, now = Date.now()) {
  return message.author.id === client.user.id &&
    message.content.includes(`<@${userId}>`) &&
    message.content.includes('Welcome a Yin Yang') &&
    now - message.createdTimestamp <= WELCOME_DEDUPE_WINDOW_MS;
}

async function recentWelcomeExists(channel, userId) {
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    return recent.some(message => isOwnWelcomeMessage(message, userId));
  } catch (err) {
    console.error('Error comprobando bienvenida reciente:', err);
    return false;
  }
}

async function cleanupWelcomeDuplicates(channel, userId) {
  try {
    const recent = await channel.messages.fetch({ limit: 50 });
    const now = Date.now();
    const welcomes = [...recent
      .filter(message => isOwnWelcomeMessage(message, userId, now))
      .values()]
      .sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const duplicate of welcomes.slice(1)) {
      await duplicate.delete().catch(err => {
        console.error(`No se pudo borrar bienvenida duplicada ${duplicate.id}:`, err);
      });
    }
    if (welcomes.length > 1) {
      console.warn(`⚠️ [${INSTANCE_ID}] se limpiaron ${welcomes.length - 1} bienvenidas duplicadas para ${userId}`);
    }
  } catch (err) {
    console.error('Error limpiando bienvenidas duplicadas:', err);
  }
}

// ── ID de instancia — ayuda a detectar si hay 2 procesos corriendo a la vez ──
const INSTANCE_ID = Math.random().toString(36).slice(2, 8);
console.log(`🔖 Instancia iniciada: ${INSTANCE_ID} (PID ${process.pid})`);

// ── Cliente Discord ──────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FUNCIONES ORIGINALES (bienvenida, moderación, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

function getMemberTag(member) {
  const roles = [...member.roles.cache.values()]
    .filter(role => role.id !== member.guild.id)
    .sort((a, b) => b.position - a.position);
  return roles.length ? roles[0].name : 'Miembro';
}

// ── Rol automático de miembros ───────────────────────────────────────────────
const MEMBER_ROLE_NAME  = 'miembro';
const MEMBER_ROLE_COLOR = 0x808080; // gris #808080

async function assignMemberRole(member) {
  try {
    let role = member.guild.roles.cache.find(
      candidate => candidate.name.toLowerCase() === MEMBER_ROLE_NAME
    );

    if (!role) {
      role = await member.guild.roles.create({
        name: MEMBER_ROLE_NAME,
        color: MEMBER_ROLE_COLOR,
        reason: 'Rol automático para nuevos miembros',
      });
      console.log(`✅ [${INSTANCE_ID}] rol "${MEMBER_ROLE_NAME}" creado en gris`);
    } else if (role.color !== MEMBER_ROLE_COLOR && role.editable) {
      await role.edit({
        color: MEMBER_ROLE_COLOR,
        reason: 'Mantener el color gris del rol automático de miembros',
      });
      console.log(`✅ [${INSTANCE_ID}] color del rol "${MEMBER_ROLE_NAME}" actualizado a gris`);
    }

    if (!role.editable) {
      console.error(`❌ [${INSTANCE_ID}] no puedo administrar el rol "${role.name}"; sube el rol del bot por encima de ese rol`);
      return false;
    }

    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role, 'Asignación automática al entrar al servidor');
      console.log(`✅ [${INSTANCE_ID}] rol "${role.name}" asignado a ${member.user.tag}`);
    }
    return true;
  } catch (err) {
    console.error(`❌ [${INSTANCE_ID}] error asignando el rol "${MEMBER_ROLE_NAME}" a ${member.user.tag}:`, err);
    return false;
  }
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

// Dibuja un símbolo yin-yang clásico (split S + dos puntos) en (cx, cy) con radio r
function drawYinYang(ctx, cx, cy, r) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(cx - r, cy - r, r * 2, r);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(cx - r, cy, r * 2, r);

  ctx.fillStyle = '#0a0a0a';
  ctx.beginPath();
  ctx.arc(cx, cy - r / 2, r / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.arc(cx, cy + r / 2, r / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f2f2f2';
  ctx.beginPath();
  ctx.arc(cx, cy - r / 2, r / 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#0a0a0a';
  ctx.beginPath();
  ctx.arc(cx, cy + r / 2, r / 6, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

// Dibuja un icono tipo "hamburguesa" (3 barritas) centrado en (cx, cy)
function drawHamburger(ctx, cx, cy, w, color) {
  ctx.fillStyle = color;
  for (let i = -1; i <= 1; i++) {
    ctx.fillRect(cx - w / 2, cy + i * 4 - 1, w, 2);
  }
}

async function createWelcomeImage(member) {
  const W = 860;
  const H = 280;
  const R = 22; // radio de esquina de toda la tarjeta
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#050505';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  roundRect(ctx, 0, 0, W, H, R);
  ctx.clip();

  // Fondo metálico oscuro con highlight superior
  const bgGrad = ctx.createLinearGradient(0, 0, 0, H);
  bgGrad.addColorStop(0,    '#1c1c1c');
  bgGrad.addColorStop(0.18, '#0d0d0d');
  bgGrad.addColorStop(1,    '#050505');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, W, H);

  const avatarSize = 132;
  const avatarX    = 76 + avatarSize / 2;
  const avatarY    = H / 2;
  const divX       = 76 + avatarSize + 50;

  // ── Panel izquierdo: split diagonal blanco/negro (estilo Yin Yang) ────────
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, divX, H);
  ctx.clip();

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, divX, H);

  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(divX * 0.7, 0);
  ctx.lineTo(divX * 0.18, H);
  ctx.lineTo(0, H);
  ctx.closePath();
  const panelGrad = ctx.createLinearGradient(0, 0, divX, H);
  panelGrad.addColorStop(0, '#fafafa');
  panelGrad.addColorStop(1, '#c4c4c4');
  ctx.fillStyle = panelGrad;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(divX * 0.7, 0);
  ctx.lineTo(divX * 0.18, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Remaches yin-yang sobre el panel blanco
  drawYinYang(ctx, 26, 26, 8);
  drawYinYang(ctx, 26, H - 26, 8);

  ctx.restore();

  // ── Divisor vertical con símbolo yin-yang central con glow ────────────────
  const divGrad = ctx.createLinearGradient(0, 30, 0, H - 30);
  divGrad.addColorStop(0,   'rgba(255,255,255,0)');
  divGrad.addColorStop(0.3, 'rgba(255,255,255,0.55)');
  divGrad.addColorStop(0.7, 'rgba(255,255,255,0.55)');
  divGrad.addColorStop(1,   'rgba(255,255,255,0)');
  ctx.fillStyle = divGrad;
  ctx.fillRect(divX, 30, 2, H - 60);

  ctx.save();
  ctx.shadowColor = '#ffffff';
  ctx.shadowBlur  = 14;
  drawYinYang(ctx, divX, avatarY, 13);
  ctx.restore();

  // ── Avatar: anillo tipo cápsula con dos remaches ───────────────────────────
  const ringGrad = ctx.createLinearGradient(
    avatarX - avatarSize / 2, avatarY - avatarSize / 2,
    avatarX + avatarSize / 2, avatarY + avatarSize / 2
  );
  ringGrad.addColorStop(0, '#ffffff');
  ringGrad.addColorStop(1, '#8a8a8a');
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarSize / 2 + 6, 0, Math.PI * 2);
  ctx.lineWidth   = 4;
  ctx.strokeStyle = ringGrad;
  ctx.stroke();

  const avatarResponse = await fetch(member.user.displayAvatarURL({ extension: 'png', size: 512 }));
  const avatarBuffer   = Buffer.from(await avatarResponse.arrayBuffer());
  const avatar         = await loadImage(avatarBuffer);

  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX, avatarY, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(avatar, avatarX - avatarSize / 2, avatarY - avatarSize / 2, avatarSize, avatarSize);
  ctx.restore();

  const rivetR = avatarSize / 2 + 6;
  for (const angleDeg of [45, 225]) {
    const rad = (angleDeg * Math.PI) / 180;
    const rx  = avatarX + Math.cos(rad) * rivetR;
    const ry  = avatarY + Math.sin(rad) * rivetR;
    ctx.beginPath();
    ctx.arc(rx, ry, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.lineWidth   = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.stroke();
  }

  // ── Texto ──────────────────────────────────────────────────────────────────
  const textX = divX + 38;
  ctx.textBaseline = 'middle';
  ctx.textAlign    = 'left';

  // Pill "WELCOME A YIN YANG" con iconos hamburguesa a los lados
  ctx.font = '15px "BebasNeue"';
  const tagText  = 'WELCOME A YIN YANG';
  const tagW     = ctx.measureText(tagText).width;
  const hbW      = 12;
  const innerGap = 10;
  const pillPadX = 16;
  const pillW    = pillPadX * 2 + hbW + innerGap + tagW + innerGap + hbW;
  const pillH    = 30;
  const pillX    = textX;
  const pillY    = 68;

  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  roundRect(ctx, pillX, pillY - pillH / 2, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth   = 1;
  roundRect(ctx, pillX, pillY - pillH / 2, pillW, pillH, pillH / 2);
  ctx.stroke();

  drawHamburger(ctx, pillX + pillPadX + hbW / 2, pillY, hbW, '#dc2626');
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 6;
  ctx.fillStyle   = '#e5e5e5';
  ctx.fillText(tagText, pillX + pillPadX + hbW + innerGap, pillY);
  ctx.shadowBlur  = 0;
  drawHamburger(ctx, pillX + pillPadX + hbW + innerGap + tagW + innerGap + hbW / 2, pillY, hbW, '#dc2626');

  // Nombre de usuario — Bebas Neue grande, con glow blanco
  ctx.font = '58px "BebasNeue"';
  let displayName = member.user.username;
  while (ctx.measureText(displayName).width > W - textX - 30 && displayName.length > 4) {
    displayName = displayName.slice(0, -1);
  }
  if (displayName !== member.user.username) displayName += '…';

  ctx.save();
  ctx.shadowColor = 'rgba(255,255,255,0.55)';
  ctx.shadowBlur  = 18;
  ctx.fillStyle   = '#ffffff';
  ctx.fillText(displayName, textX, 136);
  ctx.restore();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(displayName, textX, 136);

  // "en Yin Yang | Script Hub" — gris plata
  ctx.font        = '21px "BebasNeue"';
  ctx.fillStyle   = '#9ca3af';
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur  = 6;
  ctx.fillText(`en ${member.guild.name}`, textX, 180);
  ctx.shadowBlur  = 0;

  // Pill inferior "MIEMBRO | #XXXX" con icono yin-yang incrustado
  ctx.font = '15px "BebasNeue"';
  const memberText = `MIEMBRO   |   #${member.guild.memberCount}`;
  const memberW    = ctx.measureText(memberText).width;
  const badgeIconR = 8;
  const badgePadX  = 14;
  const badgeGap   = 10;
  const badgeH     = 32;
  const badgeW     = badgePadX * 2 + badgeIconR * 2 + badgeGap + memberW;
  const badgeX     = textX;
  const badgeY     = 216;

  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  roundRect(ctx, badgeX, badgeY - badgeH / 2, badgeW, badgeH, badgeH / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth   = 1;
  roundRect(ctx, badgeX, badgeY - badgeH / 2, badgeW, badgeH, badgeH / 2);
  ctx.stroke();

  drawYinYang(ctx, badgeX + badgePadX + badgeIconR, badgeY, badgeIconR);

  ctx.fillStyle = '#e5e5e5';
  ctx.fillText(memberText, badgeX + badgePadX + badgeIconR * 2 + badgeGap, badgeY);

  ctx.restore(); // fin clip de la tarjeta redondeada

  // ── Borde metálico exterior ───────────────────────────────────────────────
  const borderGrad = ctx.createLinearGradient(0, 0, W, H);
  borderGrad.addColorStop(0,   'rgba(255,255,255,0.5)');
  borderGrad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  borderGrad.addColorStop(1,   'rgba(255,255,255,0.4)');
  roundRect(ctx, 1, 1, W - 2, H - 2, R);
  ctx.strokeStyle = borderGrad;
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  return canvas.toBuffer('image/png');
}

// ── Moderación ───────────────────────────────────────────────────────────────
const ALLOWED_LINKS_FILE = path.join(__dirname, 'allowed-links.json');
const WARNINGS_FILE      = path.join(__dirname, 'warnings.json');

const URL_REGEX           = /(https?:\/\/[^\s"'<>]+)|(discord(?:\.gg|app\.com\/invite|\.com\/invite)\/[^\s"'<>]+)/gi;
const DISCORD_INVITE_REGEX = /discord(?:\.gg|app\.com\/invite|\.com\/invite)\//i;

function loadAllowedLinks() {
  if (!fs.existsSync(ALLOWED_LINKS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(ALLOWED_LINKS_FILE, 'utf8')); } catch { return []; }
}
function saveAllowedLinks(list) {
  fs.writeFileSync(ALLOWED_LINKS_FILE, JSON.stringify(list, null, 2), 'utf8');
}
function loadWarnings() {
  if (!fs.existsSync(WARNINGS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')); } catch { return {}; }
}
function saveWarnings(data) {
  fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function extractDomain(url) {
  try {
    const normalized = url.match(/^https?:\/\//i) ? url : `https://${url}`;
    return new URL(normalized).hostname.replace(/^www\./i, '').toLowerCase();
  } catch { return null; }
}
function extractInviteCode(url) {
  const match = url.match(/discord(?:\.gg|app\.com\/invite|\.com\/invite)\/([a-z0-9-]+)/i);
  return match ? match[1].toLowerCase() : null;
}

// Algunos servicios publican el mismo contenido en varios hosts. Una entrada
// simple como "youtube.com" o "tiktok.com" debe cubrir también sus enlaces
// cortos y subdominios oficiales, pero no se aplica a entradas con una ruta.
const LINK_DOMAIN_GROUPS = [
  ['youtube', 'youtube.com', 'youtu.be'],
  ['tiktok', 'tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com', 'm.tiktok.com'],
];

function domainMatchesAllowed(domain, entry) {
  const e = entry.toLowerCase().trim();
  if (domain === e || domain.endsWith(`.${e}`)) return true;

  const group = LINK_DOMAIN_GROUPS.find(hosts => hosts.includes(e));
  return group ? group.some(host => domain === host || domain.endsWith(`.${host}`)) : false;
}

// ── Normaliza una entrada de la whitelist o un link recibido a "dominio/ruta" ─
// Quita protocolo, "www.", y la barra final, todo en minúsculas.
function normalizeLinkPath(url) {
  try {
    const normalized = url.match(/^https?:\/\//i) ? url : `https://${url}`;
    const u = new URL(normalized);
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    const path = u.pathname.replace(/\/+$/, '').toLowerCase(); // sin barra final, sin distinguir mayúsculas (igual que la whitelist)
    return host + path;
  } catch { return null; }
}
// ── Verifica si un link está permitido ────────────────────────────────────────
// - Entrada CON ruta (ej: "raw.githubusercontent.com/miuser/mirepo"):
//   solo permite ESE repo/ruta exacta, no todo el dominio.
// - Entrada SOLO dominio (ej: "tenor.com"): permite cualquier ruta bajo ese dominio,
//   igual que antes (compatibilidad con entradas ya guardadas).
function isLinkAllowed(raw, allowedDomains) {
  const cleanedPath = normalizeLinkPath(raw);
  const domain      = extractDomain(raw);
  if (!cleanedPath || !domain) return false;

  return allowedDomains.some(entry => {
    const e = entry.toLowerCase().trim();
    if (e.includes('/')) {
      // Entrada con ruta específica — match exacto o subcarpeta de esa ruta
      return cleanedPath === e || cleanedPath.startsWith(`${e}/`);
    }
    // Entrada de solo dominio — incluye aliases oficiales del servicio.
    return domainMatchesAllowed(domain, e);
  });
}
function findDisallowedLink(content, allowedDomains) {
  const matches = content.match(URL_REGEX);
  if (!matches) return null;
  const allowedInviteCodes = allowedDomains.map(d => extractInviteCode(d)).filter(Boolean);
  for (const raw of matches) {
    if (DISCORD_INVITE_REGEX.test(raw)) {
      const code = extractInviteCode(raw);
      if (code && allowedInviteCodes.includes(code)) continue;
      return raw;
    }
    if (!isLinkAllowed(raw, allowedDomains)) return raw;
  }
  return null;
}

async function createWarningImage(member, reasonText) {
  const W = 900; const H = 260;
  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext('2d');

  // ── Fondo casi negro con leve gradiente radial rojo ─────────────────────────
  const bgGrad = ctx.createRadialGradient(W * 0.15, H * 0.5, 0, W * 0.15, H * 0.5, W * 0.9);
  bgGrad.addColorStop(0, '#1a0505');
  bgGrad.addColorStop(1, '#0a0202');
  ctx.fillStyle = bgGrad;
  roundRect(ctx, 0, 0, W, H, 22);
  ctx.fill();

  // ── Borde exterior con glow ──────────────────────────────────────────────────
  ctx.save();
  ctx.shadowColor = 'rgba(255,40,40,0.55)';
  ctx.shadowBlur  = 18;
  ctx.lineWidth   = 3;
  ctx.strokeStyle = '#ff2d2d';
  roundRect(ctx, 3, 3, W - 6, H - 6, 20);
  ctx.stroke();
  ctx.restore();

  // ── Borde interior fino ──────────────────────────────────────────────────────
  ctx.lineWidth   = 1;
  ctx.strokeStyle = 'rgba(255,90,90,0.5)';
  roundRect(ctx, 10, 10, W - 20, H - 20, 16);
  ctx.stroke();

  const avatarSize = 130; const avatarX = 70 + avatarSize / 2; const avatarY = H / 2;

  // ── Anillo del avatar con glow ────────────────────────────────────────────────
  ctx.save();
  ctx.shadowColor = 'rgba(255,45,45,0.6)';
  ctx.shadowBlur  = 14;
  ctx.beginPath(); ctx.arc(avatarX, avatarY, avatarSize / 2 + 6, 0, Math.PI * 2);
  ctx.lineWidth = 5; ctx.strokeStyle = '#ff2d2d'; ctx.stroke();
  ctx.restore();

  const avatarResponse = await fetch(member.user.displayAvatarURL({ extension: 'png', size: 512 }));
  const avatarBuffer   = Buffer.from(await avatarResponse.arrayBuffer());
  const avatar         = await loadImage(avatarBuffer);

  ctx.save();
  ctx.beginPath(); ctx.arc(avatarX, avatarY, avatarSize / 2, 0, Math.PI * 2); ctx.clip();
  ctx.drawImage(avatar, avatarX - avatarSize / 2, avatarY - avatarSize / 2, avatarSize, avatarSize);
  ctx.restore();

  // ── Insignia de advertencia solapada (esquina inferior derecha del avatar) ───
  const badgeX = avatarX + avatarSize / 2 - 8;
  const badgeY = avatarY + avatarSize / 2 - 8;
  const badgeR = 22;
  ctx.save();
  ctx.shadowColor = 'rgba(255,45,45,0.7)';
  ctx.shadowBlur  = 10;
  ctx.beginPath();
  ctx.moveTo(badgeX, badgeY - badgeR);
  ctx.lineTo(badgeX + badgeR * 0.95, badgeY + badgeR * 0.8);
  ctx.lineTo(badgeX - badgeR * 0.95, badgeY + badgeR * 0.8);
  ctx.closePath();
  ctx.fillStyle = '#0a0202';
  ctx.fill();
  ctx.lineWidth = 2.5; ctx.strokeStyle = '#ff2d2d'; ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#ff2d2d';
  ctx.font = 'bold 20px "Inter"';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('!', badgeX, badgeY + 3);

  const textX = 70 + avatarSize + 45;

  // ── Escudo pequeño con "!" junto al nombre ────────────────────────────────────
  const shieldCX = textX + 14; const shieldCY = 58; const shieldR = 16;
  ctx.save();
  ctx.shadowColor = 'rgba(255,45,45,0.6)';
  ctx.shadowBlur  = 8;
  ctx.beginPath();
  ctx.moveTo(shieldCX, shieldCY - shieldR);
  ctx.quadraticCurveTo(shieldCX + shieldR, shieldCY - shieldR * 0.6, shieldCX + shieldR, shieldCY - shieldR * 0.1);
  ctx.quadraticCurveTo(shieldCX + shieldR, shieldCY + shieldR * 0.75, shieldCX, shieldCY + shieldR);
  ctx.quadraticCurveTo(shieldCX - shieldR, shieldCY + shieldR * 0.75, shieldCX - shieldR, shieldCY - shieldR * 0.1);
  ctx.quadraticCurveTo(shieldCX - shieldR, shieldCY - shieldR * 0.6, shieldCX, shieldCY - shieldR);
  ctx.closePath();
  ctx.fillStyle = '#ff2d2d';
  ctx.fill();
  ctx.restore();
  ctx.fillStyle = '#0a0202';
  ctx.font = 'bold 18px "Inter"';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('!', shieldCX, shieldCY + 1);

  // ── Nombre de usuario ──────────────────────────────────────────────────────────
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = 'bold 34px "Inter"'; ctx.fillStyle = '#FFFFFF';
  ctx.fillText(member.user.username, textX + 34, 60);

  // ── Línea divisoria con destello a la derecha ─────────────────────────────────
  const lineY = 96;
  const lineGrad = ctx.createLinearGradient(textX, lineY, W - 50, lineY);
  lineGrad.addColorStop(0, 'rgba(255,80,80,0.9)');
  lineGrad.addColorStop(0.85, 'rgba(255,80,80,0.9)');
  lineGrad.addColorStop(1, 'rgba(255,80,80,0)');
  ctx.strokeStyle = lineGrad; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(textX, lineY); ctx.lineTo(W - 50, lineY); ctx.stroke();

  // ── Texto de advertencia (bilingüe, del bloque original) ─────────────────────
  ctx.font = 'bold 19px "Inter"'; ctx.fillStyle = '#ff4d4d';
  wrapText(ctx, reasonText, textX, 128, W - textX - 50, 27);

  return canvas.toBuffer('image/png');
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = ''; let curY = y;
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, x, curY); line = word; curY += lineHeight;
    } else { line = testLine; }
  }
  if (line) ctx.fillText(line, x, curY);
}

async function applyModerationStrike(message, reasonText, extraMessagesToDelete = []) {
  const warnings = loadWarnings();
  const guildId  = message.guild.id;
  const userId   = message.author.id;
  if (!warnings[guildId]) warnings[guildId] = {};
  const current = (warnings[guildId][userId] || 0) + 1;
  warnings[guildId][userId] = current;
  saveWarnings(warnings);

  const toDelete = [message, ...extraMessagesToDelete];
  const seenIds  = new Set();
  for (const m of toDelete) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    await m.delete().catch(() => {});
  }

  try {
    const image = await createWarningImage(message.member, reasonText);
    await message.channel.send(withMessageNonce({
      content: `<@${userId}>`,
      files: [new AttachmentBuilder(image, { name: 'warning.png' })]
    }, 'moderation-warning', guildId, message.channel.id, message.id));
  } catch (err) { console.error('Error generando imagen de advertencia:', err); }
  await deduplicateOwnMention(message.channel, userId);

  if (current >= 2) {
    if (message.member.bannable) {
      await message.member.ban({ reason: '2da infracción: links/spam no permitido' }).catch(err => {
        console.error('Error baneando miembro:', err);
      });
      warnings[guildId][userId] = 0;
      saveWarnings(warnings);
    } else {
      console.error(`No se pudo banear a ${message.author.tag}: sin permisos suficientes.`);
    }
  }
}

// ── Anti-spam ────────────────────────────────────────────────────────────────
const recentMessages    = new Map();
const SPAM_WINDOW_MS    = 10000;
const SPAM_REPEAT_COUNT = 3;

function registerMessageForSpamCheck(message) {
  const userId  = message.author.id;
  const now     = Date.now();
  const history = recentMessages.get(userId) || [];
  const updated = history.filter(m => now - m.ts < SPAM_WINDOW_MS);
  updated.push({ message, ts: now });
  recentMessages.set(userId, updated);
  const sameCount = updated.filter(m => m.message.content === message.content).length;
  if (sameCount >= SPAM_REPEAT_COUNT) {
    recentMessages.delete(userId);
    return updated.map(m => m.message);
  }
  return null;
}

// ── Protección de @everyone (solo dueño/admins pueden usarlo) ─────────────────
const EVERYONE_WARNINGS_FILE = path.join(__dirname, 'everyone-warnings.json');

function loadEveryoneWarnings() {
  try { return JSON.parse(fs.readFileSync(EVERYONE_WARNINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveEveryoneWarnings(data) {
  fs.writeFileSync(EVERYONE_WARNINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

async function applyEveryoneStrike(message) {
  const warnings = loadEveryoneWarnings();
  const guildId  = message.guild.id;
  const userId   = message.author.id;
  if (!warnings[guildId]) warnings[guildId] = {};
  const current = (warnings[guildId][userId] || 0) + 1;
  warnings[guildId][userId] = current;
  saveEveryoneWarnings(warnings);

  await message.delete().catch(() => {});

  const reasonText = 'Don\'t use the everyone again or you will be eliminated';
  try {
    const image = await createWarningImage(message.member, reasonText);
    await message.channel.send(withMessageNonce({
      content: `<@${userId}>`,
      files: [new AttachmentBuilder(image, { name: 'warning.png' })]
    }, 'everyone-warning', guildId, message.channel.id, message.id));
  } catch (err) { console.error('Error generando imagen de advertencia (everyone):', err); }
  await deduplicateOwnMention(message.channel, userId);

  if (current >= 2) {
    // ── 2da vez: le quita el permiso de escribir en este canal ────────────────
    try {
      await message.channel.permissionOverwrites.edit(userId, { SendMessages: false });
    } catch (err) {
      console.error(`No se pudo restringir el canal para ${message.author.tag}:`, err);
    }
    return;
  }

  // ── 1ra vez: mute 1 hora + borra mensajes del último minuto ─────────────────
  if (message.member.moderatable) {
    await message.member.timeout(60 * 60 * 1000, 'Uso no autorizado de @everyone').catch(err => {
      console.error('Error muteando miembro:', err);
    });
  } else {
    console.error(`No se pudo mutear a ${message.author.tag}: sin permisos suficientes.`);
  }

  try {
    const recent    = await message.channel.messages.fetch({ limit: 100 });
    const oneMinAgo = Date.now() - 60000;
    const toDelete  = recent.filter(m => m.author.id === userId && m.createdTimestamp >= oneMinAgo);
    if (toDelete.size > 0) await message.channel.bulkDelete(toDelete, true).catch(() => {});
  } catch (err) { console.error('Error borrando mensajes recientes:', err); }
}

// ── Recordatorios ────────────────────────────────────────────────────────────
const REMINDERS_FILE = path.join(__dirname, 'reminders.json');
const activeTimers   = new Map();

function loadReminders() {
  if (!fs.existsSync(REMINDERS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8')); } catch { return []; }
}
function saveReminders(reminders) {
  fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2), 'utf8');
}
function startReminder(reminder) {
  if (activeTimers.has(reminder.id)) return;
  const timer = setInterval(async () => {
    try {
      const channel = await client.channels.fetch(reminder.channelId);
      if (channel?.isTextBased()) {
        const payload = { content: reminder.message };
        if (reminder.attachmentUrl) payload.files = [reminder.attachmentUrl];
        const slot = Math.floor(Date.now() / reminder.intervalMs);
        await channel.send(withMessageNonce(payload, 'reminder', reminder.channelId, reminder.id, slot));
      }
    } catch (err) { console.error(`Error enviando recordatorio ${reminder.id}:`, err); }
  }, reminder.intervalMs);
  activeTimers.set(reminder.id, timer);
  console.log(`✅ Recordatorio "${reminder.id}" activo cada ${reminder.intervalMs / 60000} min`);
}
function parseInterval(str) {
  const match = str.trim().match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;
  const val  = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  return val * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COMANDOS SLASH
// ═══════════════════════════════════════════════════════════════════════════════

const reminderCommand = new SlashCommandBuilder()
  .setName('recordatorio')
  .setDescription('Crea un recordatorio periódico')
  .addStringOption(opt => opt.setName('intervalo').setDescription('Cada cuánto enviar (ej: 30m, 2h, 1d)').setRequired(true))
  .addChannelOption(opt => opt.setName('canal').setDescription('Canal donde se enviará el mensaje').setRequired(true))
  .addStringOption(opt => opt.setName('mensaje').setDescription('Mensaje del recordatorio').setRequired(true))
  .addStringOption(opt => opt.setName('id').setDescription('Nombre único para este recordatorio').setRequired(true))
  .addAttachmentOption(opt => opt.setName('archivo').setDescription('Imagen o video para adjuntar (opcional)').setRequired(false));

const deleteCommand = new SlashCommandBuilder()
  .setName('borrar-recordatorio')
  .setDescription('Elimina un recordatorio activo')
  .addStringOption(opt => opt.setName('id').setDescription('ID del recordatorio a borrar').setRequired(true));

const listLinksCommand = new SlashCommandBuilder()
  .setName('links-permitidos')
  .setDescription('Muestra la lista de dominios permitidos en el servidor')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

const editLinksCommand = new SlashCommandBuilder()
  .setName('editar-links')
  .setDescription('Agrega o quita un dominio de la lista de links permitidos')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addStringOption(opt =>
    opt.setName('accion').setDescription('Qué hacer con el dominio').setRequired(true)
      .addChoices({ name: 'Agregar', value: 'agregar' }, { name: 'Quitar', value: 'quitar' })
  )
  .addStringOption(opt => opt.setName('dominio').setDescription('Dominio a agregar o quitar (ej: youtube.com)').setRequired(true));

// ═══════════════════════════════════════════════════════════════════════════════
//  EVENTOS
// ═══════════════════════════════════════════════════════════════════════════════

client.once('ready', async () => {
  console.log(`✅ Bot listo como ${client.user.tag} — [${INSTANCE_ID}] PID ${process.pid}, ws.status=${client.ws.status}, ping=${client.ws.ping}ms`);

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), {
      body: [
        reminderCommand.toJSON(),
        deleteCommand.toJSON(),
        listLinksCommand.toJSON(),
        editLinksCommand.toJSON(),
      ]
    });
    console.log('✅ Comandos slash registrados');
  } catch (err) {
    console.error('Error registrando comandos:', err);
  }

  const reminders = loadReminders();
  for (const r of reminders) startReminder(r);
});

// ── Interacciones (slash commands) ──────────────────────────────────────────
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  // ── /recordatorio ──────────────────────────────────────────────────────────
  if (interaction.commandName === 'recordatorio') {
    const intervalStr = interaction.options.getString('intervalo');
    const channel     = interaction.options.getChannel('canal');
    const message     = interaction.options.getString('mensaje');
    const id          = interaction.options.getString('id').toLowerCase().replace(/\s+/g, '-');
    const attachment  = interaction.options.getAttachment('archivo');
    const ms          = parseInterval(intervalStr);
    if (!ms) return interaction.reply({ content: '❌ Formato inválido. Usá: `30m`, `2h`, `1d`, `90s`', ephemeral: true });
    if (ms < 60000) return interaction.reply({ content: '❌ El intervalo mínimo es 1 minuto.', ephemeral: true });
    const reminders = loadReminders();
    if (reminders.find(r => r.id === id)) return interaction.reply({ content: `❌ Ya existe un recordatorio con el ID \`${id}\`.`, ephemeral: true });
    const reminder = { id, channelId: channel.id, message, intervalMs: ms, attachmentUrl: attachment ? attachment.url : null };
    reminders.push(reminder); saveReminders(reminders); startReminder(reminder);
    return interaction.reply({ content: `✅ Recordatorio \`${id}\` creado.\n📣 Canal: <#${channel.id}>\n⏱ Cada: **${intervalStr.toLowerCase()}**\n💬 Mensaje: ${message}${attachment ? `\n📎 Adjunto: ${attachment.name}` : ''}`, ephemeral: true });
  }

  // ── /borrar-recordatorio ───────────────────────────────────────────────────
  if (interaction.commandName === 'borrar-recordatorio') {
    const id        = interaction.options.getString('id').toLowerCase().replace(/\s+/g, '-');
    const reminders = loadReminders();
    const idx       = reminders.findIndex(r => r.id === id);
    if (idx === -1) return interaction.reply({ content: `❌ No encontré ningún recordatorio con el ID \`${id}\`.`, ephemeral: true });
    reminders.splice(idx, 1); saveReminders(reminders);
    if (activeTimers.has(id)) { clearInterval(activeTimers.get(id)); activeTimers.delete(id); }
    return interaction.reply({ content: `✅ Recordatorio \`${id}\` eliminado.`, ephemeral: true });
  }

  // ── /links-permitidos ─────────────────────────────────────────────────────
  if (interaction.commandName === 'links-permitidos') {
    const allowed  = loadAllowedLinks();
    const listText = allowed.length ? allowed.map(d => `• \`${d}\``).join('\n') : '_No hay dominios configurados._';
    return interaction.reply({ content: `🔗 **Dominios permitidos:**\n${listText}`, ephemeral: true });
  }

  // ── /editar-links ──────────────────────────────────────────────────────────
  if (interaction.commandName === 'editar-links') {
    try {
      // Confirmar la interacción inmediatamente y dejar el guardado fuera del límite de 3s.
      await interaction.deferReply({ ephemeral: true });
      const accion     = interaction.options.getString('accion');
      const dominioRaw = interaction.options.getString('dominio');
      const dominio    = normalizeLinkPath(dominioRaw);
      if (!dominio) {
        return interaction.editReply({
          content: '❌ Eso no parece un dominio o URL válida. Ejemplo: `tenor.com` (todo el dominio) o `raw.githubusercontent.com/tuUsuario/tuRepo` (solo ese repo).',
        });
      }
      const allowed = loadAllowedLinks();
      if (accion === 'agregar') {
        if (allowed.includes(dominio)) return interaction.editReply({ content: `❌ \`${dominio}\` ya está en la lista.` });
        allowed.push(dominio); saveAllowedLinks(allowed);
        return interaction.editReply({ content: `✅ \`${dominio}\` agregado.` });
      }
      if (accion === 'quitar') {
        const idx = allowed.indexOf(dominio);
        if (idx === -1) return interaction.editReply({ content: `❌ \`${dominio}\` no está en la lista.` });
        allowed.splice(idx, 1); saveAllowedLinks(allowed);
        return interaction.editReply({ content: `✅ \`${dominio}\` eliminado.` });
      }
      return interaction.editReply({ content: '❌ Acción no válida. Elegí agregar o quitar.' });
    } catch (err) {
      console.error('Error en /editar-links:', err);
      const content = '❌ No pude guardar la lista de dominios. Revisá los permisos de administración o intentá nuevamente.';
      if (interaction.deferred && !interaction.replied) return interaction.editReply({ content });
      return interaction.reply({ content, ephemeral: true }).catch(() => {});
    }
  }

});

// ── Bienvenida ───────────────────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  if (!markProcessed(processedMemberJoins, member.id)) {
    console.warn(`⚠️ [${INSTANCE_ID}] guildMemberAdd duplicado ignorado — miembro ${member.id}`);
    return;
  }
  try {
    await assignMemberRole(member);
    const channel = await member.guild.channels.fetch(WELCOME_CHANNEL_ID);
    if (!channel?.isTextBased()) return;
    if (await recentWelcomeExists(channel, member.id)) {
      console.warn(`⚠️ [${INSTANCE_ID}] bienvenida reciente ya existe — miembro ${member.id}`);
      return;
    }
    const image = await createWelcomeImage(member);
    const sent = await channel.send(withMessageNonce({
      content: `✦ ***Welcome a Yin Yang | Script Hub*** ✦ ${member}\n> 👤 Eres el miembro **#${member.guild.memberCount}** de nuestro servidor\n> 📜 Leé las reglas y bienvenido/a a la comunidad`,
      files  : [new AttachmentBuilder(image, { name: 'welcome.png' })],
    }, 'welcome', member.guild.id, member.id));
    console.log(`✅ [${INSTANCE_ID}] bienvenida enviada — miembro ${member.id}, mensaje ${sent.id}`);
    await cleanupWelcomeDuplicates(channel, member.id);
  } catch (err) {
    console.error('Error en bienvenida:', err);
  }
});

// ── Mensajes ─────────────────────────────────────────────────────────────────
client.on('messageCreate', async message => {
  if (!markProcessed(processedMessageIds, message.id)) {
    console.warn(`⚠️ [${INSTANCE_ID}] messageCreate duplicado ignorado — mensaje ${message.id}`);
    return;
  }
  try {
    if (message.author.bot) return;
    if (!message.guild)     return;

    const isAdmin = message.member?.permissions.has(PermissionFlagsBits.Administrator);

    // Moderación: @everyone no autorizado (solo dueño/admins pueden usarlo)
    if (!isAdmin && message.content.includes('@everyone')) {
      await applyEveryoneStrike(message);
      return;
    }

    if (!isAdmin) {
      // Moderación: link no permitido
      const allowedDomains = loadAllowedLinks();
      const badLink        = findDisallowedLink(message.content, allowedDomains);
      if (badLink) {
        await applyModerationStrike(message, 'Do not send links, it is not allowed to send, do not send another one or else if you will not be permanently banned');
        return;
      }
      // Moderación: spam
      if (message.content.trim().length > 0) {
        const spamMessages = registerMessageForSpamCheck(message);
        if (spamMessages) {
          await applyModerationStrike(message, "Don't spam again or you'll be banned.", spamMessages);
          return;
        }
      }
    }

    // ── Comando !welcome (preview) ──────────────────────────────────────────
    if (message.content.toLowerCase() === '!welcome') {
      const image = await createWelcomeImage(message.member);
      await message.reply({ content: '🔍 Vista previa', files: [new AttachmentBuilder(image, { name: 'preview.png' })] });
    }

  } catch (err) {
    console.error('Error en messageCreate:', err);
  }
});

// ── Apagado limpio ───────────────────────────────────────────────────────────
// Railway manda SIGTERM al contenedor viejo cuando hace un redeploy.
// Sin esto, el proceso puede quedar colgado unos segundos todavía conectado
// al gateway de Discord mientras el proceso nuevo ya arrancó — generando una
// ventana donde ambos responden a los mismos eventos (bienvenidas/avisos duplicados).
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM recibido — cerrando conexión con Discord...');
  client.destroy()
    .then(() => console.log('✅ Conexión cerrada limpiamente'))
    .catch(err => console.error('Error cerrando conexión:', err))
    .finally(() => process.exit(0));
  // Salvavidas: si algo cuelga, no dejar el proceso vivo más de 5s igual
  setTimeout(() => process.exit(0), 5000);
});

// ── Arranque ──────────────────────────────────────────────────────────────────
loadFonts().then(() => {
  client.login(TOKEN);
}).catch(err => {
  console.error('Error cargando fuentes:', err);
  client.login(TOKEN);
});
