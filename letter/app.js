const CLOUD_API_BASE = 'https://memory-anet-api-ggwahnbtst.cn-shenzhen.fcapp.run';
const LETTER_ID = 'memory-letter-platform';
const $ = s => document.querySelector(s);
const cover = $('#cover');
const letterPage = $('#letterPage');
const topbar = $('#topbar');
const audio = $('#bgm');
const disc = $('#disc');
const openBtn = $('#openBtn');
const musicStatus = $('#musicStatus');
const voiceAudio = $('#voiceAudio');
let resumeMusicAfterVoice = false;
let content = null;

function showMusicStatus(message) {
  musicStatus.textContent = message;
  musicStatus.classList.toggle('hidden', !message);
}

async function playMusic() {
  if (!content?.music) return;
  showMusicStatus('音乐正在加载…');
  try {
    await audio.play();
    showMusicStatus('');
  } catch (_) {
    showMusicStatus('音乐没响？点上方按钮重试');
  }
}

function splitParagraphs(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split(/\n\s*\n+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function addPhoto(container, photo) {
  const fig = document.createElement('figure');
  fig.className = 'memory-photo fade-in' + (photo.layout === 'wide' ? ' photo-wide' : photo.layout === 'compact' ? ' photo-compact' : '');
  const img = document.createElement('img');
  img.src = photo.src;
  img.alt = photo.caption || '我们的照片';
  img.loading = 'lazy';
  fig.appendChild(img);
  if (photo.caption) {
    const cap = document.createElement('figcaption');
    cap.textContent = photo.caption;
    fig.appendChild(cap);
  }
  container.appendChild(fig);
}

function renderLetter() {
  $('#coverTitle').textContent = content.title || '给你的一封信';
  $('#coverDate').textContent = content.date || '';
  $('#coverIntro').textContent = content.intro || '';
  $('#pageTitle').textContent = content.title || '';
  $('#pageDate').textContent = content.date || '';
  $('#signature').textContent = content.signature || '';
  if (content.endingCopy) $('.ending-copy').textContent = content.endingCopy;
  $('#musicLabel').textContent = content.musicTitle || '背景音乐';

  if (content.hero) {
    $('#coverBg').style.backgroundImage = `url("${content.hero}")`;
  } else {
    $('#coverBg').style.backgroundImage = 'radial-gradient(circle at 35% 25%, #8f7e70, #2a2420 72%)';
  }

  if (content.music) {
    audio.src = content.music;
    audio.load();
  }
  if (content.voice) {
    voiceAudio.src = content.voice;
    $('#voiceNote').classList.remove('hidden');
  }

  const body = $('#letterBody');
  body.innerHTML = '';
  const paras = splitParagraphs(content.letter);
  const photos = Array.isArray(content.photos) ? content.photos : [];
  const positions = new Map();

  photos.forEach((photo, i) => {
    const automatic = paras.length ? Math.min(paras.length, Math.max(1, Math.round(((i + 1) * paras.length) / (photos.length + 1)))) : 0;
    const chosen = Number(photo.afterParagraph);
    const pos = photo.afterParagraph === null || photo.afterParagraph === undefined || photo.afterParagraph === '' || !Number.isInteger(chosen)
      ? automatic : Math.max(0, Math.min(paras.length, chosen));
    if (!positions.has(pos)) positions.set(pos, []);
    positions.get(pos).push(photo);
  });

  (positions.get(0) || []).forEach(photo => addPhoto(body, photo));

  paras.forEach((text, i) => {
    const p = document.createElement('p');
    p.className = 'fade-in';
    p.textContent = text;
    body.appendChild(p);
    const list = positions.get(i + 1) || [];
    list.forEach(photo => addPhoto(body, photo));
  });
}

async function load() {
  const res = await fetch(`${CLOUD_API_BASE}/projects/${encodeURIComponent(LETTER_ID)}`, {cache:'no-store'});
  if (!res.ok) throw new Error('内容加载失败');
  const record = await res.json();
  content = record.payload?.published ? record.payload.letterContent : null;
  if (!content) throw new Error('信件尚未迁移');
  renderLetter();
  openBtn.disabled = false;
  openBtn.textContent = '打开这封信';
}

async function startExperience() {
  if (!content) return;
  cover.classList.add('hidden');
  letterPage.classList.remove('hidden');
  topbar.classList.remove('hidden');
  window.scrollTo(0, 0);

  if (content.music) await playMusic();
}

openBtn.addEventListener('click', startExperience);
$('#musicBtn').addEventListener('click', async () => {
  if (!content?.music) return;
  if (audio.paused) {
    if (!voiceAudio.paused) voiceAudio.pause();
    resumeMusicAfterVoice = false;
    await playMusic();
  } else {
    audio.pause();
    disc.classList.remove('playing');
    showMusicStatus('');
  }
});

audio.addEventListener('play', () => disc.classList.add('playing'));
audio.addEventListener('pause', () => disc.classList.remove('playing'));
audio.addEventListener('playing', () => showMusicStatus(''));
audio.addEventListener('waiting', () => showMusicStatus('音乐正在缓冲…'));
audio.addEventListener('error', () => showMusicStatus('音乐加载失败，点上方按钮重试'));
voiceAudio.addEventListener('play', () => {
  resumeMusicAfterVoice = !audio.paused;
  audio.pause();
});
voiceAudio.addEventListener('ended', async () => {
  if (resumeMusicAfterVoice && content?.music) {
    try { await audio.play(); } catch (_) {}
  }
  resumeMusicAfterVoice = false;
});

load().catch(() => {
  openBtn.textContent = '加载失败，请刷新重试';
  $('#coverIntro').textContent = '页面加载失败，请刷新后重试。';
});
