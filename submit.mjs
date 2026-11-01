import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";

const ROOT_DIR = process.cwd();
const LMS_BASE_URL = "https://lms.umt.edu.pk";
const ENV_FILE = path.join(ROOT_DIR, ".env");
const COURSES_CONFIG_FILE = path.join(ROOT_DIR, ".config", "courses.json");

// ============================================================================
// .ENV & AUTO-TOKEN AUTHENTICATION
// ============================================================================
function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) return;
  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
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
  let content = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, "utf8")
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
  fs.writeFileSync(ENV_FILE, content, "utf8");
}

async function fetchTokenFromCredentials() {
  const username = process.env.LMS_USERNAME;
  const password = process.env.LMS_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "Missing LMS_USERNAME or LMS_PASSWORD in .env file. Set them in .env first.",
    );
  }

  console.log(`[Auth] Generating token for '${username}'...`);
  const form = new URLSearchParams({
    username,
    password,
    service: "moodle_mobile_app",
  });

  const res = await fetch(`${LMS_BASE_URL}/login/token.php`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (data.error || !data.token) {
    throw new Error(`Failed to get token: ${data.error || "Unknown error"}`);
  }

  saveTokenToEnv(data.token);
  console.log("[Auth] Token saved to .env (UMT_MOODLE_TOKEN).");
  return data.token;
}

async function ensureAuthenticated() {
  loadEnvFile();
  let token = process.env.UMT_MOODLE_TOKEN;
  if (token) {
    try {
      const siteInfo = await moodleRpc(token, "core_webservice_get_site_info");
      if (siteInfo?.userid) return { token, siteInfo };
    } catch {
      console.log("[Auth] Saved token expired. Fetching a fresh token...");
    }
  }
  token = await fetchTokenFromCredentials();
  const siteInfo = await moodleRpc(token, "core_webservice_get_site_info");
  return { token, siteInfo };
}

// ============================================================================
// COURSE NAME FORMATTER & API HELPERS
// ============================================================================
function parseCourseDetails(fullname = "", shortname = "") {
  const segments = fullname
    .split(/\s+[-–—]\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const code =
    segments[0] && /^[A-Za-z]{2,4}\d{3,4}[A-Za-z]?$/.test(segments[0])
      ? segments[0].toUpperCase()
      : "COURSE";
  const subject =
    segments.length >= 2 ? segments[1].replace(/\s+/g, " ") : fullname;
  const section =
    segments.length >= 4 && !/^(OC|OL)$/i.test(segments[3])
      ? segments[3].toUpperCase()
      : "";

  return {
    code,
    subject,
    section,
    display: section
      ? `${code} - ${subject} (${section})`
      : `${code} - ${subject}`,
  };
}

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

async function moodleRpc(token, wsfunction, params = {}) {
  const url = new URL(`${LMS_BASE_URL}/webservice/rest/server.php`);
  url.searchParams.set("wstoken", token);
  url.searchParams.set("wsfunction", wsfunction);
  url.searchParams.set("moodlewsrestformat", "json");

  const body = new URLSearchParams();
  appendParams(params, body);

  const res = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

  const data = await res.json();
  if (data?.exception) {
    throw new Error(`Moodle API Error [${data.errorcode}]: ${data.message}`);
  }
  return data;
}

async function uploadFilesToDraft(token, filePaths) {
  let draftItemId = 0;

  for (let i = 0; i < filePaths.length; i++) {
    const cleanInput = filePaths[i].replace(/^['"]|['"]$/g, "").trim();
    const resolvedPath = path.resolve(cleanInput);

    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`File does not exist: ${resolvedPath}`);
    }
    const stat = fs.statSync(resolvedPath);
    if (!stat.isFile()) {
      throw new Error(`Path is not a file: ${resolvedPath}`);
    }

    const filename = path.basename(resolvedPath);
    const blob = new Blob([fs.readFileSync(resolvedPath)]);

    const form = new FormData();
    form.append("token", token);
    form.append("filearea", "draft");
    form.append("itemid", String(draftItemId));
    form.append("file", blob, filename);

    console.log(
      `  -> Uploading [${i + 1}/${filePaths.length}]: ${filename} (${(stat.size / 1024).toFixed(1)} KB)...`,
    );

    const res = await fetch(`${LMS_BASE_URL}/webservice/upload.php`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      throw new Error(`Upload failed (${res.status}): ${res.statusText}`);
    }

    const uploadResult = await res.json();
    if (!Array.isArray(uploadResult) || uploadResult.length === 0) {
      throw new Error(`Unexpected response: ${JSON.stringify(uploadResult)}`);
    }

    draftItemId = uploadResult[0].itemid;
  }

  return draftItemId;
}

function formatEpoch(epochSec) {
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

// ============================================================================
// MAIN CLI
// ============================================================================
async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      course: { type: "string", short: "c" },
      assign: { type: "string", short: "a" },
      file: { type: "string", short: "f", multiple: true },
      finalize: { type: "boolean" },
      all: { type: "boolean" },
      list: { type: "boolean", short: "l" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
Usage:
  Interactive Mode:
    node submit.mjs

  Command-Line Flags:
    node submit.mjs --course <index|id> --assign <index|id> --file <path> [--finalize]
    node submit.mjs --list [--all]
`);
    return;
  }

  console.log("\n==========================================");
  console.log("   UMT MOODLE LAB & ASSIGNMENT SUBMITTER   ");
  console.log("==========================================\n");

  const { token, siteInfo } = await ensureAuthenticated();
  console.log(`Logged in as: ${siteInfo.fullname} (${siteInfo.username})`);

  let courses = await moodleRpc(token, "core_enrol_get_users_courses", {
    userid: siteInfo.userid,
  });

  // Filter by saved courses in .config/courses.json unless --all is passed
  if (!values.all && fs.existsSync(COURSES_CONFIG_FILE)) {
    try {
      const savedIds = JSON.parse(fs.readFileSync(COURSES_CONFIG_FILE, "utf8"));
      const filtered = courses.filter((c) => savedIds.includes(c.id));
      if (filtered.length > 0) courses = filtered;
    } catch {}
  }

  if (!courses?.length) {
    console.log("No courses found.");
    return;
  }

  if (values.list) {
    for (const c of courses) {
      const info = parseCourseDetails(c.fullname, c.shortname);
      console.log(`\n[Course ID: ${c.id}] ${info.display}`);
      const assignData = await moodleRpc(token, "mod_assign_get_assignments", {
        courseids: [c.id],
      });
      const list = assignData.courses?.[0]?.assignments || [];
      if (!list.length) {
        console.log("   (No assignments or lab tasks)");
        continue;
      }
      for (const a of list) {
        console.log(
          `   - [Assign ID: ${a.id}] ${a.name} (Due: ${formatEpoch(a.duedate)})`,
        );
      }
    }
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const prompt = async (q) => (await rl.question(q)).trim();

  try {
    console.log("\n--- Active Courses ---");
    courses.forEach((c, idx) => {
      const info = parseCourseDetails(c.fullname, c.shortname);
      console.log(` [${idx + 1}] ${info.display} (ID: ${c.id})`);
    });

    const courseInput =
      values.course ||
      (await prompt("\nSelect a course (Enter # index or Course ID): "));
    const courseNum = parseInt(courseInput, 10);
    const selectedCourse =
      courseNum >= 1 && courseNum <= courses.length
        ? courses[courseNum - 1]
        : courses.find((c) => c.id === courseNum);

    if (!selectedCourse) {
      console.error(`Invalid course selection: "${courseInput}"`);
      return;
    }

    const courseInfo = parseCourseDetails(
      selectedCourse.fullname,
      selectedCourse.shortname,
    );
    console.log(`\n[✓] Selected Course: ${courseInfo.display}`);

    const assignData = await moodleRpc(token, "mod_assign_get_assignments", {
      courseids: [selectedCourse.id],
    });
    const courseAssignments = assignData.courses?.[0]?.assignments || [];
    if (!courseAssignments.length) {
      console.log("No assignments or lab tasks found for this course.");
      return;
    }

    const enrichedList = [];
    for (const a of courseAssignments) {
      let statusData = null;
      try {
        statusData = await moodleRpc(
          token,
          "mod_assign_get_submission_status",
          { assignid: a.id },
        );
      } catch {}

      const lastAttempt = statusData?.lastattempt;
      const subStatus = lastAttempt?.submission?.status || "new";
      const canEdit = !!lastAttempt?.canedit;
      const canSubmit = !!lastAttempt?.cansubmit;
      const filePlugin = lastAttempt?.submission?.plugins?.find(
        (p) => p.type === "file",
      );
      const existingFiles =
        filePlugin?.fileareas?.[0]?.files?.map((f) => f.filename) || [];

      enrichedList.push({
        id: a.id,
        name: a.name,
        duedate: a.duedate,
        status: subStatus === "new" ? "not submitted" : subStatus,
        canEdit,
        canSubmit,
        existingFiles,
      });
    }

    console.log("\n--- Submissions ---");
    enrichedList.forEach((a, idx) => {
      const lockTag = a.canEdit ? "[OPEN]" : "[LOCKED]";
      const filesTag = a.existingFiles.length
        ? ` | Uploaded: ${a.existingFiles.join(", ")}`
        : "";
      console.log(
        ` [${idx + 1}] ${a.name} (ID: ${a.id})\n` +
          `     Status: ${a.status.toUpperCase()} ${lockTag}${filesTag}\n` +
          `     Due:    ${formatEpoch(a.duedate)}`,
      );
    });

    const assignInput =
      values.assign ||
      (await prompt("\nSelect submission (Enter # index or Assign ID): "));
    const assignNum = parseInt(assignInput, 10);
    const selectedAssign =
      assignNum >= 1 && assignNum <= enrichedList.length
        ? enrichedList[assignNum - 1]
        : enrichedList.find((a) => a.id === assignNum);

    if (!selectedAssign) {
      console.error(`Invalid selection: "${assignInput}"`);
      return;
    }

    if (!selectedAssign.canEdit && !values.assign) {
      console.warn(
        "\n[!] Warning: Moodle reports this submission is closed/locked (canedit = false).",
      );
      const proceed = (
        await prompt("Attempt upload anyway? (y/N): ")
      ).toLowerCase();
      if (proceed !== "y") return;
    }

    let filePaths = values.file || [];
    if (!filePaths.length) {
      const rawInput = await prompt(
        "\nEnter file path(s) to submit (comma-separated, or drag & drop file here):\n> ",
      );
      if (!rawInput) return console.log("No files entered. Aborted.");
      filePaths = rawInput
        .split(",")
        .map((p) => p.replace(/^['"]|['"]$/g, "").trim())
        .filter(Boolean);
    }

    for (const fp of filePaths) {
      const resolved = path.resolve(fp);
      if (!fs.existsSync(resolved)) {
        console.error(`[!] File not found: ${resolved}`);
        return;
      }
    }

    if (!values.assign && !values.course) {
      console.log("\n--- Confirm Submission ---");
      console.log(`Course:     ${courseInfo.display}`);
      console.log(`Submission: ${selectedAssign.name}`);
      filePaths.forEach((fp) => {
        const resolved = path.resolve(fp);
        const sizeKB = (fs.statSync(resolved).size / 1024).toFixed(1);
        console.log(`File:       ${path.basename(resolved)} (${sizeKB} KB)`);
      });

      const ok = (
        await prompt("\nUpload and submit now? (y/N): ")
      ).toLowerCase();
      if (ok !== "y") return console.log("Cancelled.");
    }

    console.log("\n[1/3] Uploading file(s) to Moodle draft area...");
    const draftItemId = await uploadFilesToDraft(token, filePaths);

    console.log("[2/3] Linking files to assignment submission...");
    const saveRes = await moodleRpc(token, "mod_assign_save_submission", {
      assignmentid: selectedAssign.id,
      plugindata: { files_filemanager: draftItemId },
    });
    if (saveRes?.warnings?.length) {
      console.warn("Moodle warnings:", saveRes.warnings);
    }

    const updatedStatus = await moodleRpc(
      token,
      "mod_assign_get_submission_status",
      { assignid: selectedAssign.id },
    );

    if (updatedStatus?.lastattempt?.cansubmit) {
      let finalize = values.finalize;
      if (finalize === undefined) {
        const ans = (
          await prompt(
            "\n[3/3] Finalize and lock submission for grading? (Y/n): ",
          )
        ).toLowerCase();
        finalize = ans !== "n";
      }
      if (finalize) {
        await moodleRpc(token, "mod_assign_submit_for_grading", {
          assignmentid: selectedAssign.id,
          acceptsubmissionstatement: 1,
        });
      }
    }

    const finalCheck = await moodleRpc(
      token,
      "mod_assign_get_submission_status",
      { assignid: selectedAssign.id },
    );
    const finalStatus =
      finalCheck?.lastattempt?.submission?.status || "unknown";
    const finalFiles =
      finalCheck?.lastattempt?.submission?.plugins
        ?.find((p) => p.type === "file")
        ?.fileareas?.[0]?.files?.map((f) => f.filename) || [];

    console.log("\n==========================================");
    console.log(`Status: ${finalStatus.toUpperCase()}`);
    console.log(`Files:  ${finalFiles.join(", ") || "None"}`);
    console.log("==========================================\n");
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("\n[!] Error:", err.message);
  process.exit(1);
});
