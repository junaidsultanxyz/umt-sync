import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { google } from "googleapis";

// ============================================================================
// CONFIGURATION & PATHS
// ============================================================================
const ROOT_DIR = process.cwd();
const CONFIG = {
  baseUrl: "https://lms.umt.edu.pk",
  rootDir: ROOT_DIR,
  envFile: path.join(ROOT_DIR, ".env"),
  materialDir: path.join(ROOT_DIR, "material"),
  configDir: path.join(ROOT_DIR, ".config"),
  coursesConfigFile: path.join(ROOT_DIR, ".config", "courses.json"),
  stateFile: path.join(ROOT_DIR, ".config", "state.json"),
  tasksManifestFile: path.join(ROOT_DIR, ".config", "tasks.json"),
  driveTokenPath: path.join(ROOT_DIR, ".config", "drive-token.json"),
  credentialsPath: path.join(ROOT_DIR, "credentials.json"),
  maxFileSizeMB: 50,
};

// Block all image extensions & template "Mid Term" noise
const IMAGE_EXT_REGEX =
  /\.(png|jpe?g|gif|svg|webp|bmp|ico|tiff?|avif|jfif|heic)$/i;
const IGNORED_FILE_NAME_REGEX =
  /\b(mid\s*[-_]?term|final\s*[-_]?term\s*exam)\b/i;
const IGNORED_SECTION_NAME_REGEX = /\b(mid\s*[-_]?term|final\s*[-_]?term)\b/i;

function isSkippedFilename(name = "") {
  const clean = name.trim();
  if (!clean) return true;
  if (IMAGE_EXT_REGEX.test(clean)) return true;
  if (IGNORED_FILE_NAME_REGEX.test(clean)) return true;
  return false;
}

// ============================================================================
// .ENV LOADER & AUTO-TOKEN MANAGER
// ============================================================================
function loadEnvFile() {
  if (!fs.existsSync(CONFIG.envFile)) return;
  const lines = fs.readFileSync(CONFIG.envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed
      .slice(eqIdx + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}

function saveTokenToEnv(token) {
  process.env.UMT_MOODLE_TOKEN = token;
  let content = fs.existsSync(CONFIG.envFile)
    ? fs.readFileSync(CONFIG.envFile, "utf8")
    : "";

  if (/^UMT_MOODLE_TOKEN\s*=.*/m.test(content)) {
    content = content.replace(
      /^UMT_MOODLE_TOKEN\s*=.*/m,
      `UMT_MOODLE_TOKEN=${token}`,
    );
  } else {
    const prefix = content && !content.endsWith("\n") ? "\n" : "";
    content += `${prefix}UMT_MOODLE_TOKEN=${token}\n`;
  }
  fs.writeFileSync(CONFIG.envFile, content, "utf8");
}

async function fetchNewMoodleToken() {
  const username = process.env.LMS_USERNAME;
  const password = process.env.LMS_PASSWORD;

  if (!username || !password) {
    throw new Error(
      "Missing LMS_USERNAME or LMS_PASSWORD in .env file. Please add them to .env.",
    );
  }

  console.log(`[Auth] Requesting Moodle token for '${username}'...`);
  const body = new URLSearchParams({
    username,
    password,
    service: "moodle_mobile_app",
  });

  const res = await fetch(`${CONFIG.baseUrl}/login/token.php`, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    throw new Error(`Token request failed: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (data.error || !data.token) {
    throw new Error(`LMS Login Error: ${data.error || "No token returned"}`);
  }

  saveTokenToEnv(data.token);
  console.log("[Auth] Token fetched and saved to .env (UMT_MOODLE_TOKEN).");
  return data.token;
}

async function ensureAuthenticated() {
  loadEnvFile();
  let token = process.env.UMT_MOODLE_TOKEN;

  if (token && token !== "PASTE_YOUR_MOODLE_TOKEN_HERE") {
    try {
      const siteInfo = await moodleRpc(
        "core_webservice_get_site_info",
        {},
        token,
      );
      if (siteInfo?.userid) return { token, siteInfo };
    } catch {
      console.log("[Auth] Saved token expired or invalid. Refreshing...");
    }
  }

  token = await fetchNewMoodleToken();
  const siteInfo = await moodleRpc("core_webservice_get_site_info", {}, token);
  return { token, siteInfo };
}

// ============================================================================
// PERSISTENT STATE CACHE & CLEANUP
// ============================================================================
function loadState() {
  fs.mkdirSync(CONFIG.configDir, { recursive: true });
  if (fs.existsSync(CONFIG.stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
      return {
        moodleFiles: parsed.moodleFiles || {},
        driveFiles: parsed.driveFiles || {},
        externalFiles: parsed.externalFiles || {},
      };
    } catch {}
  }
  return {
    moodleFiles: {},
    driveFiles: {},
    externalFiles: {},
  };
}

function saveState(state) {
  fs.mkdirSync(CONFIG.configDir, { recursive: true });
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2), "utf8");
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Cleans up any previously downloaded images, Mid Term template files,
 * empty directories, and old root-level markdown files.
 */
function cleanupMaterialFolder() {
  for (const oldMd of ["assignments.md", "quizzes.md", "labtasks.md"]) {
    const rootMdPath = path.join(CONFIG.rootDir, oldMd);
    if (fs.existsSync(rootMdPath)) {
      try {
        fs.rmSync(rootMdPath, { force: true });
      } catch {}
    }
  }

  if (!fs.existsSync(CONFIG.materialDir)) return;

  const walkAndClean = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_SECTION_NAME_REGEX.test(entry.name)) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        } else {
          walkAndClean(fullPath);
          if (
            fs.existsSync(fullPath) &&
            fs.readdirSync(fullPath).length === 0
          ) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          }
        }
      } else if (entry.isFile()) {
        // Only remove unwanted Mid Term / Final Term template files; keep existing images
        if (IGNORED_FILE_NAME_REGEX.test(entry.name)) {
          try {
            fs.rmSync(fullPath, { force: true });
            console.log(
              `  [-] Removed unwanted file: ${path.relative(CONFIG.rootDir, fullPath)}`,
            );
          } catch {}
        }
      }
    }
  };

  walkAndClean(CONFIG.materialDir);
}

// ============================================================================
// UMT COURSE, SECTION, & FILENAME PARSERS
// ============================================================================
function parseCourseDetails(fullname = "", shortname = "") {
  const segments = fullname
    .split(/\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  let code = "";
  if (segments[0] && /^[A-Za-z]{2,4}\d{3,4}[A-Za-z]?$/.test(segments[0])) {
    code = segments[0].toUpperCase();
  } else {
    const codeMatch = `${shortname} ${fullname}`.match(
      /\b([A-Za-z]{2,4})\s*[-_]?\s*(\d{3,4}[A-Za-z]?)\b/,
    );
    code = codeMatch
      ? `${codeMatch[1].toUpperCase()}${codeMatch[2].toUpperCase()}`
      : "COURSE";
  }

  let rawSubject = segments.length >= 2 ? segments[1] : fullname;

  let section = "";
  if (segments.length >= 4) {
    const candidate = segments[3];
    if (
      /^[A-Za-z0-9]{1,5}$/.test(candidate) &&
      !/^(OC|OL|F\d{4}|S\d{4})$/i.test(candidate)
    ) {
      section = candidate.toUpperCase();
    }
  }
  if (!section) {
    const shortParts = shortname.split(/\s+-\s+/)[0]?.split("-") || [];
    const lastPart = shortParts[shortParts.length - 1];
    if (
      lastPart &&
      /^[A-Za-z]{1,2}\d{1,3}[A-Za-z]?$/.test(lastPart) &&
      lastPart.toUpperCase() !== code
    ) {
      section = lastPart.toUpperCase();
    }
  }

  const teacher = segments.length >= 3 ? segments[2] : "";

  const subjectSlug =
    rawSubject
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "subject";

  const slug = section
    ? `${code.toLowerCase()}_${subjectSlug}_${section.toLowerCase()}`
    : `${code.toLowerCase()}_${subjectSlug}`;

  const cleanSubjectTitle = rawSubject.replace(/\s+/g, " ").trim();
  const display = section
    ? `${code} (${cleanSubjectTitle} - ${section})`
    : `${code} (${cleanSubjectTitle})`;

  return {
    code,
    subject: cleanSubjectTitle,
    teacher,
    section,
    slug,
    display,
  };
}

function resolveSectionFolderName(sec) {
  const rawName = (sec.name || "").trim();
  const secNum = Number(sec.section ?? 0);

  if (IGNORED_SECTION_NAME_REGEX.test(rawName)) {
    return null; // Skip Mid Term / Final Term placeholder sections
  }

  if (
    secNum === 0 ||
    /read\s*this\s*first|course\s*outline|general|intro(?:duction)?|welcome|syllabus/i.test(
      rawName,
    )
  ) {
    return "read this first";
  }

  const weekMatch = rawName.match(/week\s*0*(\d+)/i);
  if (weekMatch) {
    return `week ${parseInt(weekMatch[1], 10)}`;
  }

  return `week ${secNum}`;
}

function sanitizeFilename(name = "") {
  let decoded = name;
  try {
    decoded = decodeURIComponent(name);
  } catch {}
  return (
    decoded
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "file"
  );
}

function formatDateTime(epochSec) {
  if (!epochSec) return "No due date";
  return new Date(epochSec * 1000).toLocaleString("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function htmlToMarkdown(html = "") {
  if (!html) return "";
  return html
    .replace(/<img\b[^>]*>/gi, "")
    .replace(
      /<a\s+[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>(.*?)<\/a>/gis,
      (_, url, text) => {
        const cleanUrl = url.replace(/&amp;/g, "&").trim();
        const label = text.replace(/<[^>]+>/g, "").trim() || cleanUrl;
        return label === cleanUrl ? cleanUrl : `[${label}](${cleanUrl})`;
      },
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<li>/gi, "- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractAllLinks(htmlOrText = "") {
  if (!htmlOrText) return [];
  const urls = new Set();

  // Remove <img> tags completely
  const withoutImages = htmlOrText.replace(/<img\b[^>]*>/gi, " ");

  const hrefRegex = /href=["']\s*(https?:\/\/[^"'\s>]+)\s*["']/gi;
  let match;
  while ((match = hrefRegex.exec(withoutImages)) !== null) {
    urls.add(match[1].replace(/&amp;/g, "&").trim());
  }

  const rawRegex = /https?:\/\/[^\s"'<>)\]]+/gi;
  while ((match = rawRegex.exec(withoutImages)) !== null) {
    urls.add(
      match[0]
        .replace(/&amp;/g, "&")
        .replace(/[.,;]+$/, "")
        .trim(),
    );
  }

  return [...urls].filter((u) => {
    const cleanPath = u.split("?")[0];
    return !IMAGE_EXT_REGEX.test(cleanPath);
  });
}

// ============================================================================
// MOODLE RPC & UNIVERSAL FILE/LINK DOWNLOADERS
// ============================================================================
function appendParams(params, body, prefix = "") {
  for (const [key, value] of Object.entries(params)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      appendParams(value, body, fullKey);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === "object") appendParams(v, body, `${fullKey}[${i}]`);
        else body.append(`${fullKey}[${i}]`, v);
      });
    } else if (value !== undefined) {
      body.append(fullKey, value);
    }
  }
}

async function moodleRpc(
  wsfunction,
  params = {},
  token = process.env.UMT_MOODLE_TOKEN,
) {
  const url = new URL(`${CONFIG.baseUrl}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", token);
  url.searchParams.set("wsfunction", wsfunction);
  url.searchParams.set("moodlewsrestformat", "json");

  const body = new URLSearchParams();
  appendParams(params, body);

  const res = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(25000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} on ${wsfunction}`);
  }

  const data = await res.json();
  if (data?.exception) {
    throw new Error(`${wsfunction}: ${data.message}`);
  }
  return data;
}

function normalizeMoodlePluginFileUrl(rawUrl = "") {
  try {
    const u = new URL(rawUrl);
    if (!u.hostname.includes("lms.umt.edu.pk")) return null;

    if (u.pathname.startsWith("/pluginfile.php/")) {
      u.pathname = `/webservice${u.pathname}`;
    } else if (!u.pathname.startsWith("/webservice/pluginfile.php/")) {
      return null;
    }

    const segments = u.pathname.split("/").filter(Boolean);
    const lastSegment = segments[segments.length - 1] || "download";
    const filename = sanitizeFilename(decodeURIComponent(lastSegment));

    if (isSkippedFilename(filename)) return null;

    return {
      fileurl: u.toString(),
      filename,
    };
  } catch {
    return null;
  }
}

async function downloadMoodleFile(
  fileObj,
  destFolder,
  state,
  token = process.env.UMT_MOODLE_TOKEN,
) {
  const rawUrl = fileObj.fileurl;
  if (!rawUrl) return null;

  // Reject image mimeTypes if provided by Moodle
  if (fileObj.mimetype && fileObj.mimetype.startsWith("image/")) {
    return null;
  }

  const normalized = normalizeMoodlePluginFileUrl(rawUrl);
  const targetUrlStr = normalized ? normalized.fileurl : rawUrl;
  const rawName = fileObj.filename || normalized?.filename || "moodle_download";
  const filename = sanitizeFilename(rawName);

  // Strictly skip images and Mid Term template files
  if (isSkippedFilename(filename)) return null;

  const filesize = Number(fileObj.filesize || 0);
  const timemodified = Number(fileObj.timemodified || 0);
  if (filesize > CONFIG.maxFileSizeMB * 1024 * 1024) return null;

  const destPath = path.join(destFolder, filename);
  const relPath = path.relative(CONFIG.rootDir, destPath).replace(/\\/g, "/");
  const stateKey = `${targetUrlStr.split("?")[0]}::${relPath}`;

  const cached = state.moodleFiles[stateKey];
  if (
    cached &&
    fs.existsSync(destPath) &&
    fs.statSync(destPath).size > 0 &&
    (!timemodified || cached.timemodified >= timemodified)
  ) {
    return relPath;
  }
  if (!cached && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    state.moodleFiles[stateKey] = { timemodified, relPath };
    return relPath;
  }

  try {
    const url = new URL(targetUrlStr);
    url.searchParams.set("token", token);

    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(45000),
    });

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const isHtmlFile = /\.html?$/i.test(filename);

    // Block HTML login pages AND any image/* content-type
    if (
      !res.ok ||
      contentType.startsWith("image/") ||
      (contentType.includes("text/html") && !isHtmlFile)
    ) {
      await res.body?.cancel();
      return null;
    }

    fs.mkdirSync(destFolder, { recursive: true });
    await pipeline(res.body, fs.createWriteStream(destPath));

    state.moodleFiles[stateKey] = { timemodified, relPath };
    console.log(`  [+] Downloaded: ${relPath}`);
    return relPath;
  } catch {
    return null;
  }
}

async function downloadDirectExternalUrl(rawUrl, destFolder, state) {
  try {
    const u = new URL(rawUrl);
    if (
      u.hostname.includes("lms.umt.edu.pk") ||
      /(?:drive|docs)\.google\.com/i.test(u.hostname)
    ) {
      return null;
    }

    const extMatch = u.pathname.match(
      /\.(pdf|pptx?|docx?|xlsx?|zip|rar|7z|csv|txt|md|py|cpp|c|h|java|js|ts|sql|ipynb|json|xml)$/i,
    );
    const isDropbox = u.hostname.includes("dropbox.com");
    if (!extMatch && !isDropbox) return null;

    if (isDropbox) {
      u.searchParams.set("dl", "1");
    }

    const rawFilename =
      decodeURIComponent(u.pathname.split("/").pop() || "") ||
      `external_${sha256(rawUrl)}`;
    const filename = sanitizeFilename(rawFilename);

    if (isSkippedFilename(filename)) return null;

    const destPath = path.join(destFolder, filename);
    const relPath = path.relative(CONFIG.rootDir, destPath).replace(/\\/g, "/");
    const stateKey = `${rawUrl}::${relPath}`;

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      state.externalFiles[stateKey] = relPath;
      return relPath;
    }

    const res = await fetch(u.toString(), {
      redirect: "follow",
      signal: AbortSignal.timeout(45000),
    });

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (
      !res.ok ||
      contentType.includes("text/html") ||
      contentType.startsWith("image/")
    ) {
      await res.body?.cancel();
      return null;
    }

    fs.mkdirSync(destFolder, { recursive: true });
    await pipeline(res.body, fs.createWriteStream(destPath));
    state.externalFiles[stateKey] = relPath;
    console.log(`  [+] Downloaded (External Link): ${relPath}`);
    return relPath;
  } catch {
    return null;
  }
}

// ============================================================================
// 2-TIER GOOGLE DRIVE CLIENT & DOWNLOADER
// ============================================================================
async function getDriveClient() {
  if (!fs.existsSync(CONFIG.credentialsPath)) {
    return null;
  }

  try {
    const content = JSON.parse(fs.readFileSync(CONFIG.credentialsPath, "utf8"));
    const creds = content.installed || content.web;
    if (!creds) return null;

    const REDIRECT_PORT = 8085;
    const redirectUri = `http://127.0.0.1:${REDIRECT_PORT}`;
    const oAuth2Client = new google.auth.OAuth2(
      creds.client_id,
      creds.client_secret,
      redirectUri,
    );

    fs.mkdirSync(CONFIG.configDir, { recursive: true });

    if (fs.existsSync(CONFIG.driveTokenPath)) {
      oAuth2Client.setCredentials(
        JSON.parse(fs.readFileSync(CONFIG.driveTokenPath, "utf8")),
      );
      return google.drive({ version: "v3", auth: oAuth2Client });
    }

    const authUrl = oAuth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/drive.readonly"],
      prompt: "consent",
    });

    console.log("\n[Google Drive Auth] Open this link in your browser:");
    console.log(authUrl);

    const code = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
          const authCode = reqUrl.searchParams.get("code");
          if (authCode) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              "<h2>Google Drive authenticated! You can close this tab and return to your terminal.</h2>",
            );
            server.close();
            resolve(authCode);
          } else {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Missing authorization code.");
          }
        } catch (err) {
          reject(err);
        }
      });
      server.listen(REDIRECT_PORT);
    });

    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    fs.writeFileSync(CONFIG.driveTokenPath, JSON.stringify(tokens, null, 2));
    console.log("[Google Drive Auth] Token saved.\n");
    return google.drive({ version: "v3", auth: oAuth2Client });
  } catch (err) {
    console.warn("[Drive] Could not initialize OAuth client:", err.message);
    return null;
  }
}

function extractDriveInfo(url = "") {
  if (!url || !/(?:drive|docs)\.google\.com/i.test(url)) return null;

  const folderMatch = url.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (folderMatch) {
    return { id: folderMatch[1], type: "folder", url };
  }

  const docMatch = url.match(
    /\/(document|presentation|spreadsheets|file)\/d\/([a-zA-Z0-9_-]{10,})/,
  );
  if (docMatch) {
    return { id: docMatch[2], type: docMatch[1], url };
  }

  const queryMatch = url.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);
  if (queryMatch) {
    return { id: queryMatch[1], type: "file", url };
  }

  return null;
}

async function tryDirectDriveDownload(driveInfo, destFolder) {
  if (driveInfo.type === "folder") return null;

  let exportUrl = "";
  let defaultExt = "";

  if (driveInfo.type === "document") {
    exportUrl = `https://docs.google.com/document/d/${driveInfo.id}/export?format=docx`;
    defaultExt = ".docx";
  } else if (driveInfo.type === "presentation") {
    exportUrl = `https://docs.google.com/presentation/d/${driveInfo.id}/export?format=pptx`;
    defaultExt = ".pptx";
  } else if (driveInfo.type === "spreadsheets") {
    exportUrl = `https://docs.google.com/spreadsheets/d/${driveInfo.id}/export?format=xlsx`;
    defaultExt = ".xlsx";
  } else {
    exportUrl = `https://drive.google.com/uc?export=download&id=${driveInfo.id}`;
  }

  try {
    const res = await fetch(exportUrl, {
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    if (
      !res.ok ||
      contentType.includes("text/html") ||
      contentType.startsWith("image/")
    ) {
      await res.body?.cancel();
      return null;
    }

    const disposition = res.headers.get("content-disposition") || "";
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const stdMatch = disposition.match(/filename="?([^";]+)"?/i);

    let rawName = utf8Match
      ? decodeURIComponent(utf8Match[1])
      : stdMatch
        ? stdMatch[1]
        : `drive_${driveInfo.id}${defaultExt}`;

    const filename = sanitizeFilename(rawName);
    if (isSkippedFilename(filename)) {
      await res.body?.cancel();
      return null;
    }

    const destPath = path.join(destFolder, filename);
    const relPath = path.relative(CONFIG.rootDir, destPath).replace(/\\/g, "/");

    if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      await res.body?.cancel();
      return [relPath];
    }

    fs.mkdirSync(destFolder, { recursive: true });
    await pipeline(res.body, fs.createWriteStream(destPath));
    console.log(`  [+] Downloaded (Drive Direct): ${relPath}`);
    return [relPath];
  } catch {
    return null;
  }
}

async function downloadDriveTarget(drive, driveInfo, destFolder, state) {
  if (!driveInfo?.id) return [];

  const cacheKey = `${driveInfo.id}::${path.relative(CONFIG.rootDir, destFolder).replace(/\\/g, "/")}`;
  const cachedPaths = state.driveFiles[cacheKey];

  if (
    Array.isArray(cachedPaths) &&
    cachedPaths.length > 0 &&
    cachedPaths.every(
      (p) =>
        !isSkippedFilename(path.basename(p)) &&
        fs.existsSync(path.join(CONFIG.rootDir, p)),
    )
  ) {
    return cachedPaths;
  }

  if (drive) {
    try {
      const files = await downloadWithDriveApi(drive, driveInfo.id, destFolder);
      if (files.length > 0) {
        state.driveFiles[cacheKey] = files;
        return files;
      }
    } catch {}
  }

  const directFiles = await tryDirectDriveDownload(driveInfo, destFolder);
  if (directFiles?.length) {
    state.driveFiles[cacheKey] = directFiles;
    return directFiles;
  }

  return [];
}

async function downloadWithDriveApi(drive, fileId, destFolder) {
  const meta = await drive.files.get({
    fileId,
    fields: "id, name, mimeType, size",
  });

  if (meta.data.mimeType?.startsWith("image/")) {
    return [];
  }

  if (meta.data.mimeType === "application/vnd.google-apps.folder") {
    const res = await drive.files.list({
      q: `'${fileId}' in parents and trashed = false`,
      fields: "files(id, name, mimeType, size)",
      pageSize: 100,
    });
    const downloaded = [];
    for (const f of res.data.files || []) {
      const items = await downloadWithDriveApi(drive, f.id, destFolder);
      downloaded.push(...items);
    }
    return downloaded;
  }

  let filename = sanitizeFilename(meta.data.name || `drive_${fileId}`);
  const exportMap = {
    "application/vnd.google-apps.document": {
      ext: ".docx",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    },
    "application/vnd.google-apps.presentation": {
      ext: ".pptx",
      mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    },
    "application/vnd.google-apps.spreadsheet": {
      ext: ".xlsx",
      mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    },
  };

  const exportSpec = exportMap[meta.data.mimeType];
  if (exportSpec && !filename.toLowerCase().endsWith(exportSpec.ext)) {
    filename = `${path.parse(filename).name}${exportSpec.ext}`;
  }

  if (isSkippedFilename(filename)) return [];

  const destPath = path.join(destFolder, filename);
  const relPath = path.relative(CONFIG.rootDir, destPath).replace(/\\/g, "/");

  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
    return [relPath];
  }

  fs.mkdirSync(destFolder, { recursive: true });

  if (exportSpec) {
    const res = await drive.files.export(
      { fileId, mimeType: exportSpec.mime },
      { responseType: "stream" },
    );
    await pipeline(res.data, fs.createWriteStream(destPath));
  } else {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" },
    );
    await pipeline(res.data, fs.createWriteStream(destPath));
  }

  console.log(`  [+] Downloaded (Drive API): ${relPath}`);
  return [relPath];
}

async function processExtractedLinks(
  links,
  destFolder,
  { drive, state, token, cmidLookup },
) {
  const downloadedFiles = [];

  for (const link of links) {
    const pluginFileObj = normalizeMoodlePluginFileUrl(link);
    if (pluginFileObj) {
      const saved = await downloadMoodleFile(
        pluginFileObj,
        destFolder,
        state,
        token,
      );
      if (saved) downloadedFiles.push(saved);
      continue;
    }

    const modViewMatch = link.match(
      /lms\.umt\.edu\.pk\/mod\/(?:resource|folder|url|page)\/view\.php\?id=(\d+)/i,
    );
    if (modViewMatch && cmidLookup) {
      const targetCmid = Number(modViewMatch[1]);
      const targetFiles = cmidLookup.get(targetCmid) || [];
      for (const fObj of targetFiles) {
        if (fObj.fileurl) {
          const saved = await downloadMoodleFile(
            fObj,
            destFolder,
            state,
            token,
          );
          if (saved) downloadedFiles.push(saved);
        } else if (fObj.externalurl) {
          const dInfo = extractDriveInfo(fObj.externalurl);
          if (dInfo) {
            const savedDrive = await downloadDriveTarget(
              drive,
              dInfo,
              destFolder,
              state,
            );
            downloadedFiles.push(...savedDrive);
          } else {
            const savedExt = await downloadDirectExternalUrl(
              fObj.externalurl,
              destFolder,
              state,
            );
            if (savedExt) downloadedFiles.push(savedExt);
          }
        }
      }
      continue;
    }

    const dInfo = extractDriveInfo(link);
    if (dInfo) {
      const savedDrive = await downloadDriveTarget(
        drive,
        dInfo,
        destFolder,
        state,
      );
      downloadedFiles.push(...savedDrive);
      continue;
    }

    const savedExt = await downloadDirectExternalUrl(link, destFolder, state);
    if (savedExt) downloadedFiles.push(savedExt);
  }

  return [...new Set(downloadedFiles)];
}

// ============================================================================
// SUBMISSION STATUS VERIFIERS
// ============================================================================
async function getAssignmentSubmissionDetails(assignId) {
  try {
    const data = await moodleRpc("mod_assign_get_submission_status", {
      assignid: assignId,
    });
    const status = data?.lastattempt?.submission?.status || "new";
    const graded = data?.lastattempt?.gradingstatus === "graded";
    const filePlugin = data?.lastattempt?.submission?.plugins?.find(
      (p) => p.type === "file",
    );
    const submittedFiles =
      filePlugin?.fileareas?.[0]?.files?.map((f) => f.filename) || [];

    return {
      submitted: status === "submitted",
      statusText:
        status === "submitted"
          ? graded
            ? "Submitted, Graded"
            : "Submitted"
          : status === "draft"
            ? "Draft Saved"
            : "Not Submitted",
      submittedFiles,
    };
  } catch {
    return {
      submitted: false,
      statusText: "Not Submitted",
      submittedFiles: [],
    };
  }
}

async function getQuizSubmissionDetails(quizId) {
  try {
    const data = await moodleRpc("mod_quiz_get_user_attempts", {
      quizid: quizId,
      status: "all",
    });
    const attempts = data?.attempts || [];
    const finished = attempts.filter((a) => a.state === "finished");
    const inProgress = attempts.some((a) => a.state === "inprogress");

    return {
      submitted: finished.length > 0,
      statusText:
        finished.length > 0
          ? "Submitted"
          : inProgress
            ? "In Progress"
            : "Not Attempted",
    };
  } catch {
    return { submitted: false, statusText: "Not Attempted" };
  }
}

// ============================================================================
// INTERACTIVE COURSE SELECTION
// ============================================================================
async function getSelectedCourses(allCourses) {
  fs.mkdirSync(CONFIG.configDir, { recursive: true });
  const forceSelect = process.argv.includes("--select");

  if (!forceSelect && fs.existsSync(CONFIG.coursesConfigFile)) {
    try {
      const savedIds = JSON.parse(
        fs.readFileSync(CONFIG.coursesConfigFile, "utf8"),
      );
      const filtered = allCourses.filter((c) => savedIds.includes(c.id));
      if (filtered.length > 0) return filtered;
    } catch {}
  }

  console.log("\n==========================================");
  console.log("          SELECT COURSES TO SYNC          ");
  console.log("==========================================");
  allCourses.forEach((c, idx) => {
    const details = parseCourseDetails(c.fullname, c.shortname);
    console.log(
      ` [${String(idx + 1).padStart(2, " ")}] ${details.display}\n      Folder: material/${details.slug}  (ID: ${c.id})`,
    );
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ans = await rl.question(
    "\nEnter course numbers to track (comma-separated or ranges, e.g. 1-9 or 1,3,5): ",
  );
  rl.close();

  const chosenIndices = new Set();
  for (const part of ans.split(",")) {
    const trimmed = part.trim();
    const rangeMatch = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      for (let i = Math.min(start, end); i <= Math.max(start, end); i++) {
        if (allCourses[i - 1]) chosenIndices.add(i - 1);
      }
    } else {
      const idx = parseInt(trimmed, 10) - 1;
      if (!isNaN(idx) && allCourses[idx]) chosenIndices.add(idx);
    }
  }

  const chosenCourses = [...chosenIndices].map((i) => allCourses[i]);
  const chosenIds = chosenCourses.map((c) => c.id);

  fs.writeFileSync(
    CONFIG.coursesConfigFile,
    JSON.stringify(chosenIds, null, 2),
    "utf8",
  );
  console.log(
    `\n[✓] Saved ${chosenIds.length} course(s) to .config/courses.json (Run with --select anytime to change).\n`,
  );
  return chosenCourses;
}

// ============================================================================
// MAIN SYNC ORCHESTRATOR
// ============================================================================
async function main() {
  const { token, siteInfo } = await ensureAuthenticated();
  console.log(`Authenticated as: ${siteInfo.fullname} (${siteInfo.username})`);

  // Clean up any previously downloaded images, Mid Term files, and old root checklists
  fs.mkdirSync(CONFIG.materialDir, { recursive: true });
  cleanupMaterialFolder();

  const allCourses = await moodleRpc(
    "core_enrol_get_users_courses",
    { userid: siteInfo.userid },
    token,
  );

  if (!allCourses?.length) {
    console.log("No enrolled courses found.");
    return;
  }

  const courses = await getSelectedCourses(allCourses);
  const courseMap = new Map(
    courses.map((c) => [c.id, parseCourseDetails(c.fullname, c.shortname)]),
  );
  const courseIds = courses.map((c) => c.id);

  const state = loadState();
  const drive = await getDriveClient();

  let moodleUrls = [];
  let moodlePages = [];
  let moodleLabels = [];
  let moodleResources = [];
  let moodleFolders = [];
  let moodleForums = [];

  try {
    const res = await moodleRpc(
      "mod_url_get_urls_by_courses",
      { courseids: courseIds },
      token,
    );
    moodleUrls = res.urls || [];
  } catch {}
  try {
    const res = await moodleRpc(
      "mod_page_get_pages_by_courses",
      { courseids: courseIds },
      token,
    );
    moodlePages = res.pages || [];
  } catch {}
  try {
    const res = await moodleRpc(
      "mod_label_get_labels_by_courses",
      { courseids: courseIds },
      token,
    );
    moodleLabels = res.labels || [];
  } catch {}
  try {
    const res = await moodleRpc(
      "mod_resource_get_resources_by_courses",
      { courseids: courseIds },
      token,
    );
    moodleResources = res.resources || [];
  } catch {}
  try {
    const res = await moodleRpc(
      "mod_folder_get_folders_by_courses",
      { courseids: courseIds },
      token,
    );
    moodleFolders = res.folders || [];
  } catch {}
  try {
    const res = await moodleRpc(
      "mod_forum_get_forums_by_courses",
      { courseids: courseIds },
      token,
    );
    moodleForums = res.forums || [];
  } catch {}

  const assignSectionMap = new Map();
  const quizSectionMap = new Map();

  // Only store genuine standalone task resources (e.g. "Assignment #1" uploaded as a file without a submission box)
  const standaloneResourceTasks = [];

  // --------------------------------------------------------------------------
  // STEP 1: WALK SECTIONS & DOWNLOAD COURSE MATERIALS (NO IMAGES / NO MIDTERM)
  // --------------------------------------------------------------------------
  console.log(
    "\n[1/4] Syncing course sections, embedded files, and Drive links...",
  );

  for (const [courseId, details] of courseMap.entries()) {
    console.log(`\n--> ${details.display}  [material/${details.slug}]`);
    const courseDir = path.join(CONFIG.materialDir, details.slug);
    let sections = [];
    try {
      sections = await moodleRpc(
        "core_course_get_contents",
        { courseid: courseId },
        token,
      );
    } catch (err) {
      console.warn(
        `  [!] Could not load contents for ${details.code}: ${err.message}`,
      );
      continue;
    }

    const courseUrls = moodleUrls.filter((u) => u.course === courseId);
    const coursePages = moodlePages.filter((p) => p.course === courseId);
    const courseLabels = moodleLabels.filter((l) => l.course === courseId);
    const courseResources = moodleResources.filter(
      (r) => r.course === courseId,
    );
    const courseFolders = moodleFolders.filter((f) => f.course === courseId);

    const cmidLookup = new Map();
    for (const r of courseResources) {
      cmidLookup.set(r.coursemodule, [
        ...(r.contentfiles || []),
        ...(r.introfiles || []),
      ]);
    }
    for (const f of courseFolders) {
      cmidLookup.set(f.coursemodule, [...(f.introfiles || [])]);
    }
    for (const u of courseUrls) {
      cmidLookup.set(u.coursemodule, [
        { externalurl: u.externalurl },
        ...(u.introfiles || []),
      ]);
    }
    for (const p of coursePages) {
      cmidLookup.set(p.coursemodule, [
        ...(p.contentfiles || []),
        ...(p.introfiles || []),
      ]);
    }
    for (const sec of sections || []) {
      for (const mod of sec.modules || []) {
        const existing = cmidLookup.get(mod.id) || [];
        const contentsFiles = (mod.contents || []).filter(
          (c) => c.type === "file" || c.type === "url",
        );
        cmidLookup.set(mod.id, [...existing, ...contentsFiles]);
      }
    }

    const linkContext = { drive, state, token, cmidLookup };

    for (const sec of sections || []) {
      const folderName = resolveSectionFolderName(sec);
      if (!folderName) continue; // Skips Mid Term / Final Term sections

      const sectionDir = path.join(courseDir, folderName);
      const sectionHtmlLinks = new Set();

      if (sec.summary) {
        extractAllLinks(sec.summary).forEach((l) => sectionHtmlLinks.add(l));
      }

      for (const mod of sec.modules || []) {
        const modTitle = (mod.name || "").trim();

        // Skip any module explicitly named "Mid Term..." or "Final Term..."
        if (IGNORED_FILE_NAME_REGEX.test(modTitle)) {
          continue;
        }

        if (mod.modname === "assign") {
          assignSectionMap.set(mod.instance, sectionDir);
        } else if (mod.modname === "quiz") {
          quizSectionMap.set(mod.instance, sectionDir);
        }

        const modDownloadedFiles = [];

        // 1. Direct files in mod.contents
        for (const item of mod.contents || []) {
          if (item.type === "file" && item.fileurl) {
            const savedRel = await downloadMoodleFile(
              item,
              sectionDir,
              state,
              token,
            );
            if (savedRel) modDownloadedFiles.push(savedRel);
          } else if (item.type === "url" && item.fileurl) {
            sectionHtmlLinks.add(item.fileurl);
          } else if (item.content) {
            extractAllLinks(item.content).forEach((l) =>
              sectionHtmlLinks.add(l),
            );
          }
        }

        // 2. Match exact module in specialized catalogs by coursemodule ID (mod.id)
        let extraHtml = "";
        if (mod.modname === "url") {
          const foundUrl = courseUrls.find(
            (u) => u.coursemodule === mod.id || u.id === mod.instance,
          );
          if (foundUrl) {
            if (foundUrl.externalurl)
              sectionHtmlLinks.add(foundUrl.externalurl);
            extraHtml = foundUrl.intro || "";
          }
        } else if (mod.modname === "page") {
          const foundPage = coursePages.find(
            (p) => p.coursemodule === mod.id || p.id === mod.instance,
          );
          if (foundPage) {
            extraHtml = `${foundPage.intro || ""}\n${foundPage.content || ""}`;
            for (const f of [
              ...(foundPage.contentfiles || []),
              ...(foundPage.introfiles || []),
            ]) {
              const saved = await downloadMoodleFile(
                f,
                sectionDir,
                state,
                token,
              );
              if (saved) modDownloadedFiles.push(saved);
            }
          }
        } else if (mod.modname === "label") {
          const foundLabel = courseLabels.find(
            (l) => l.coursemodule === mod.id || l.id === mod.instance,
          );
          if (foundLabel) {
            extraHtml = foundLabel.intro || "";
            for (const f of foundLabel.introfiles || []) {
              const saved = await downloadMoodleFile(
                f,
                sectionDir,
                state,
                token,
              );
              if (saved) modDownloadedFiles.push(saved);
            }
          }
        } else if (mod.modname === "resource") {
          const foundRes = courseResources.find(
            (r) => r.coursemodule === mod.id || r.id === mod.instance,
          );
          if (foundRes) {
            extraHtml = foundRes.intro || "";
            for (const f of [
              ...(foundRes.contentfiles || []),
              ...(foundRes.introfiles || []),
            ]) {
              const saved = await downloadMoodleFile(
                f,
                sectionDir,
                state,
                token,
              );
              if (saved) modDownloadedFiles.push(saved);
            }
          }
        }

        // Avoid concatenating mod.description + extraHtml when they are identical
        const moduleHtml = mod.description || extraHtml || "";
        const modLinks = extractAllLinks(moduleHtml);
        if (modLinks.length > 0) {
          const downloadedFromLinks = await processExtractedLinks(
            modLinks,
            sectionDir,
            linkContext,
          );
          modDownloadedFiles.push(...downloadedFromLinks);
        }

        // 3. Strictly check if a standalone uploaded file (mod_resource) is an Assignment or Lab Task
        // (e.g. "Assignment #1" in CC361 uploaded as a file without a submission box).
        // Never match mod_label, course outlines, or "Lab Manual" reading files.
        if (mod.modname === "resource") {
          const isExplicitAssignment =
            /^(?:assignment|home\s*task|homework)\b/i.test(modTitle) &&
            !/\b(solution|key|rubric|outline|syllabus|template)\b/i.test(
              modTitle,
            );

          const isExplicitLabTask =
            /^(?:lab\s*task|lab\s*assignment)\b/i.test(modTitle) &&
            !/\b(manual|solution|outline|syllabus)\b/i.test(modTitle);

          if (isExplicitAssignment || isExplicitLabTask) {
            standaloneResourceTasks.push({
              id: `res_${mod.id}`,
              moodleId: null,
              courseId,
              courseCode: details.code,
              courseDisplay: details.display,
              type: isExplicitLabTask ? "labtask" : "assignment",
              title: modTitle,
              dueDateFormatted: "No due date",
              timestamp: Number.MAX_SAFE_INTEGER - 1,
              submitted: false,
              statusText: "No Submission Box",
              submittedFiles: [],
              localFiles: [...new Set(modDownloadedFiles)],
              desc: htmlToMarkdown(moduleHtml),
            });
          }
        }
      }

      if (sectionHtmlLinks.size > 0) {
        await processExtractedLinks(
          [...sectionHtmlLinks],
          sectionDir,
          linkContext,
        );
      }

      if (
        fs.existsSync(sectionDir) &&
        fs.readdirSync(sectionDir).length === 0
      ) {
        fs.rmSync(sectionDir, { recursive: true, force: true });
      }
    }

    // Download attachments/links from Course Announcements into "read this first"
    const courseForums = moodleForums.filter((f) => f.course === courseId);
    for (const forum of courseForums) {
      try {
        const discData = await moodleRpc(
          "mod_forum_get_forum_discussions",
          { forumid: forum.id, perpage: 15 },
          token,
        );
        for (const disc of discData.discussions || []) {
          if (IGNORED_FILE_NAME_REGEX.test(disc.name || "")) continue;
          const announceDir = path.join(courseDir, "read this first");
          const msgHtml = `${disc.name || ""}\n${disc.message || ""}`;

          for (const att of disc.attachments || []) {
            if (att.fileurl) {
              await downloadMoodleFile(att, announceDir, state, token);
            }
          }

          const postLinks = extractAllLinks(msgHtml);
          if (postLinks.length > 0) {
            await processExtractedLinks(postLinks, announceDir, linkContext);
          }

          if (
            fs.existsSync(announceDir) &&
            fs.readdirSync(announceDir).length === 0
          ) {
            fs.rmSync(announceDir, { recursive: true, force: true });
          }
        }
      } catch {}
    }

    if (fs.existsSync(courseDir) && fs.readdirSync(courseDir).length === 0) {
      fs.rmSync(courseDir, { recursive: true, force: true });
    }
  }

  // --------------------------------------------------------------------------
  // STEP 2: SYNC FORMAL ASSIGNMENTS & LAB TASKS
  // --------------------------------------------------------------------------
  console.log(
    "\n[2/4] Fetching formal assignments, lab tasks, and submission statuses...",
  );
  const assignments = [];
  const labtasks = [];
  const quizzes = [];
  const unifiedTasksManifest = [];

  try {
    const assignData = await moodleRpc(
      "mod_assign_get_assignments",
      { courseids: courseIds },
      token,
    );

    for (const c of assignData.courses || []) {
      const details = courseMap.get(c.id);
      if (!details) continue;

      for (const a of c.assignments || []) {
        const title = a.name.trim();
        if (IGNORED_FILE_NAME_REGEX.test(title)) continue;

        const subInfo = await getAssignmentSubmissionDetails(a.id);
        const isLab =
          /\b(lab|practical)\b/i.test(title) || details.code.endsWith("L");

        const targetDir =
          assignSectionMap.get(a.id) ||
          path.join(
            CONFIG.materialDir,
            details.slug,
            isLab ? "lab tasks" : "assignments",
          );

        const taskFiles = [];
        const introFiles = [
          ...(a.introattachments || []),
          ...(a.introfiles || []),
        ];
        for (const f of introFiles) {
          if (f.fileurl) {
            const saved = await downloadMoodleFile(f, targetDir, state, token);
            if (saved) taskFiles.push(saved);
          }
        }

        const introLinks = extractAllLinks(a.intro || "");
        if (introLinks.length > 0) {
          const downloadedIntroLinks = await processExtractedLinks(
            introLinks,
            targetDir,
            { drive, state, token, cmidLookup: null },
          );
          taskFiles.push(...downloadedIntroLinks);
        }

        const item = {
          id: `assign_${a.id}`,
          moodleId: a.id,
          courseId: c.id,
          courseCode: details.code,
          courseDisplay: details.display,
          type: isLab ? "labtask" : "assignment",
          title,
          dueDateFormatted: formatDateTime(a.duedate),
          timestamp: a.duedate || 0,
          submitted: subInfo.submitted,
          statusText: subInfo.statusText,
          submittedFiles: subInfo.submittedFiles,
          localFiles: [...new Set(taskFiles)],
          desc: htmlToMarkdown(a.intro),
        };

        if (isLab) labtasks.push(item);
        else assignments.push(item);
        unifiedTasksManifest.push(item);
      }
    }
  } catch (err) {
    console.warn("  [!] Assignments sync warning:", err.message);
  }

  // Merge standalone resource tasks (like CC361 Assignment #1) if not already in formal tasks
  for (const resTask of standaloneResourceTasks) {
    const targetArr = resTask.type === "labtask" ? labtasks : assignments;
    const isDuplicate = targetArr.some(
      (existing) =>
        existing.courseId === resTask.courseId &&
        existing.title.toLowerCase() === resTask.title.toLowerCase(),
    );
    if (!isDuplicate) {
      targetArr.push(resTask);
      unifiedTasksManifest.push(resTask);
    }
  }

  // --------------------------------------------------------------------------
  // STEP 3: SYNC FORMAL QUIZZES
  // --------------------------------------------------------------------------
  console.log("[3/4] Fetching quizzes and verifying attempt statuses...");
  try {
    const quizData = await moodleRpc(
      "mod_quiz_get_quizzes_by_courses",
      { courseids: courseIds },
      token,
    );

    for (const q of quizData.quizzes || []) {
      const details = courseMap.get(q.course);
      if (!details) continue;

      const title = q.name.trim();
      if (IGNORED_FILE_NAME_REGEX.test(title)) continue;

      const subInfo = await getQuizSubmissionDetails(q.id);
      const targetDir =
        quizSectionMap.get(q.id) ||
        path.join(CONFIG.materialDir, details.slug, "quizzes");

      const quizFiles = [];
      for (const f of [
        ...(q.introfiles || []),
        ...(q.introattachments || []),
      ]) {
        if (f.fileurl) {
          const saved = await downloadMoodleFile(f, targetDir, state, token);
          if (saved) quizFiles.push(saved);
        }
      }

      const quizLinks = extractAllLinks(q.intro || "");
      if (quizLinks.length > 0) {
        const downloadedQuizLinks = await processExtractedLinks(
          quizLinks,
          targetDir,
          { drive, state, token, cmidLookup: null },
        );
        quizFiles.push(...downloadedQuizLinks);
      }

      const item = {
        id: `quiz_${q.id}`,
        moodleId: q.id,
        courseId: q.course,
        courseCode: details.code,
        courseDisplay: details.display,
        type: "quiz",
        title,
        dueDateFormatted: formatDateTime(q.timeclose || q.timeopen),
        timestamp: q.timeclose || q.timeopen || 0,
        submitted: subInfo.submitted,
        statusText: subInfo.statusText,
        submittedFiles: [],
        localFiles: [...new Set(quizFiles)],
        desc: htmlToMarkdown(q.intro),
      };

      quizzes.push(item);
      unifiedTasksManifest.push(item);
    }
  } catch (err) {
    console.warn("  [!] Quizzes sync warning:", err.message);
  }

  // --------------------------------------------------------------------------
  // STEP 4: WRITE CONCISE CHECKLISTS INTO material/
  // --------------------------------------------------------------------------
  console.log(
    "[4/4] Writing concise assignments.md, quizzes.md, and labtasks.md into material/...",
  );

  saveState(state);
  fs.writeFileSync(
    CONFIG.tasksManifestFile,
    JSON.stringify(unifiedTasksManifest, null, 2),
    "utf8",
  );

  const renderChecklist = (heading, items) => {
    items.sort((a, b) => (a.timestamp || Infinity) - (b.timestamp || Infinity));
    const lines = [`# ${heading}\n`];

    if (items.length === 0) {
      lines.push("_No items found._\n");
      return lines.join("\n");
    }

    for (const i of items) {
      const box = i.submitted ? "[x]" : "[ ]";
      const submittedNote =
        i.submittedFiles?.length > 0
          ? `${i.statusText}: \`${i.submittedFiles.join("`, `")}\``
          : i.statusText;

      lines.push(
        `- ${box} **[${i.dueDateFormatted}]** | **${i.courseDisplay}** — **${i.title}** *(${submittedNote})*`,
      );

      if (i.localFiles?.length > 0) {
        lines.push(
          `  > **File:** ${i.localFiles.map((f) => `\`${f}\``).join(", ")}`,
        );
      }

      if (i.desc) {
        // Filter out lines that just repeat the task title
        const descLines = i.desc
          .split("\n")
          .map((l) => l.trim())
          .filter(
            (l) =>
              l &&
              l.toLowerCase() !== i.title.toLowerCase() &&
              l !== "_No details provided._" &&
              l !== "No description provided.",
          );

        if (descLines.length > 0) {
          lines.push(descLines.map((l) => `  > ${l}`).join("\n"));
        }
      }
    }
    return lines.join("\n") + "\n";
  };

  fs.writeFileSync(
    path.join(CONFIG.materialDir, "assignments.md"),
    renderChecklist("Assignments", assignments),
    "utf8",
  );
  fs.writeFileSync(
    path.join(CONFIG.materialDir, "quizzes.md"),
    renderChecklist("Quizzes", quizzes),
    "utf8",
  );
  fs.writeFileSync(
    path.join(CONFIG.materialDir, "labtasks.md"),
    renderChecklist("Lab Tasks", labtasks),
    "utf8",
  );

  console.log(
    "\n[✓] Saved material/assignments.md, material/quizzes.md, and material/labtasks.md",
  );
}

main().catch((err) => {
  console.error("\n[!] Sync Failed:", err.message);
  process.exit(1);
});
