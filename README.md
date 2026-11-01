# UMT Moodle CLI

A command-line tool for UMT Lahore students to automatically download course materials, track assignments/quizzes/lab tasks, and submit files directly to Moodle (`lms.umt.edu.pk`) without opening a browser.

## Features

- **Automated Course & Weekly Organization:** Formats UMT course names into clean folders (`cc361_information-security_w1`) and sorts files into `read this first` and `week 1`, `week 2`, etc.
- **Deep Link & File Extraction:** Downloads standard Moodle files, embedded HTML/table `pluginfile.php` links, forum attachments, assignment/quiz attachments, and Google Drive/Docs/Slides/Sheets links.
- **Incremental Sync:** Tracks downloaded files in `.config/state.json` so subsequent runs only fetch new or updated material.
- **Live Status Checklists:** Generates `material/assignments.md`, `material/labtasks.md`, and `material/quizzes.md` with due dates, times, descriptions, and real-time submission statuses.
- **CLI Assignment Submitter:** Upload and finalize assignment or lab task files interactively or via single-line flags.

---

## Requirements

1. **Node.js v20+** (Windows, Linux, or macOS).
2. **UMT LMS Account** (student id and password).
3. **Google Cloud `credentials.json` (Optional):** If Google Drive/Docs links are restricted to `@umt.edu.pk` users or are Google Drive folders, it require Google Drive API OAuth credentials.

---

## Quick Setup

1. **Clone the repository and install dependencies:**

   ```bash
   git clone https://github.com/junaidsultanxyz/umt-sync
   cd umt-sync
   npm install
   ```

2. **Configure your credentials:**
   Copy `.env.example` to `.env` and fill in your UMT LMS username and password:

```bash
cp .env.example .env
```

```ini
LMS_USERNAME=your_umt_id
LMS_PASSWORD=your_lms_password
UMT_MOODLE_TOKEN=
```

_Note: Leave `UMT_MOODLE_TOKEN` blank. The script automatically generates and saves it on first run._

---

## Usage

### 1. Sync Course Materials & Checklists

```bash
node sync.mjs
```

- On your first run, select the courses you want to track (supports ranges like `1-9` or comma-separated numbers like `1, 3, 5`).
- Your selection is saved to `.config/courses.json`.

**Sync Flags:**

- `node sync.mjs --select` — Re-select which courses to track.
- `node sync.mjs --git` — Automatically commit and push updated `material/` files if inside a Git repo.

### 2. Submit Assignments & Lab Tasks

**Interactive Mode:**

```bash
node submit.mjs
```

**Command-Line Flags:**

```bash
# List all active courses and assignment IDs
node submit.mjs --list

# Submit a file directly and finalize for grading
node submit.mjs -c <course_index_or_id> -a <assign_index_or_id> -f ./Lab01.zip --finalize
```

---

## Optional: Google Drive API Setup (For Restricted Links & Folders)

If a teacher shares a Google Drive folder or restricts a link strictly to `@umt.edu.pk` accounts:

1. Go to the [Google Cloud Console](https://console.cloud.google.com/) signed in with your `@umt.edu.pk` email.
2. Create a new project and enable the **Google Drive API**.
3. Go to **APIs & Services > OAuth consent screen**, select **Internal**, and save.
4. Go to **APIs & Services > Credentials**, click **Create Credentials > OAuth client ID**, and select **Desktop app**.
5. Download the JSON file, rename it to `credentials.json`, and place it in the root folder of this project.
6. Run `node sync.mjs` and complete the one-time browser login. Your token will be saved to `.config/drive-token.json`.

---

## Limitations

- **Quizzes Cannot Be Attempted via CLI:** `sync.mjs` tracks quiz deadlines and verifies whether you have attempted them, but online Moodle quizzes must still be taken in a browser.
- **Some information might be missed:** If an instructor announces a task purely as plain text inside a lecture slide or discussion message without creating a Moodle Assignment box or uploading an `Assignment` file, it will not have a submission box in `submit.mjs`.
- **Locked/Past-Due Submissions:** If an instructor disables late submissions on Moodle (`canedit = false`), `submit.mjs` cannot bypass Moodle's server-side lock.
- **File Size Cap:** Files larger than `50 MB` are skipped by default during sync (configurable via `maxFileSizeMB` in `sync.mjs`).
- **Images Excluded by Design:** Decorative course images (`.png`, `.jpg`, `.svg`, etc.) and template `Mid Term` placeholders are automatically ignored.
