/**
 * GHOST — Background Service Worker (MV3)
 * Handles keyboard shortcut and relays fill to active tab.
 * Restores session key from chrome.storage.session to decrypt
 * profiles before sending — so credentials/card fields fill correctly.
 */
'use strict';

const b64  = (ab) => btoa(String.fromCharCode(...new Uint8Array(ab)));
const ub64 = (s)  => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function decryptBlob(blob, key) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(blob.iv) }, key, ub64(blob.ct)
  );
  return JSON.parse(new TextDecoder().decode(plain));
}

async function getSessionKey() {
  try {
    const d = await chrome.storage.session.get('ghostSessionKey');
    if (!d.ghostSessionKey) return null;
    return await crypto.subtle.importKey(
      'raw', ub64(d.ghostSessionKey), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']
    );
  } catch { return null; }
}

async function decryptProfile(profile, key) {
  if (!key) return profile;
  const p = JSON.parse(JSON.stringify(profile));
  if (p.__enc_creds) {
    try { Object.assign(p.credentials, await decryptBlob(p.__enc_creds, key)); } catch {}
    delete p.__enc_creds;
  }
  if (p.__enc_fin) {
    try { Object.assign(p.professional, await decryptBlob(p.__enc_fin, key)); } catch {}
    delete p.__enc_fin;
  }
  return p;
}

async function getActiveProfile(data) {
  const raw = data.profiles?.[data.activeId];
  if (!raw) return null;
  const key = await getSessionKey();
  return decryptProfile(raw, key);
}

async function sendFill(tabId, profile, settings) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'FILL_SMART', profile, settings });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/content.js'] });
      setTimeout(() => {
        chrome.tabs.sendMessage(tabId, { type: 'FILL_SMART', profile, settings }).catch(() => {});
      }, 350);
    } catch {}
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'trigger-autofill') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  const data     = await chrome.storage.local.get(['profiles', 'activeId', 'settings']);
  const settings = data.settings || { highlight: true, fillHidden: false, fillSelect: true };
  const profile  = await getActiveProfile(data);
  if (!profile) return;
  await sendFill(tab.id, profile, settings);
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type !== 'SHORTCUT_FILL') return;
  if (sender.id !== chrome.runtime.id || !sender.tab?.id) return;
  const data     = await chrome.storage.local.get(['profiles', 'activeId', 'settings']);
  const settings = data.settings || {};
  const profile  = await getActiveProfile(data);
  if (!profile) return;
  chrome.tabs.sendMessage(sender.tab.id, { type: 'FILL_SMART', profile, settings }).catch(() => {});
});
