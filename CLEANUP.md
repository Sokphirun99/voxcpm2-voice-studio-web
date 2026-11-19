# Voice Studio Cleanup & Uninstall Knowledge Base

កំណត់ត្រាផ្លូវការសម្រាប់គ្រប់គ្រង និងលុបឯកសារបណ្ដោះអាសន្ន ម៉ូដែល AI, Python Virtual Environments, LaunchAgents និង Docker Containers របស់ `project-text-to-voice` ដើម្បីសន្សំទំហំ Disk នៅលើ macOS ដោយ **មិនប៉ះពាល់ដល់ Project ផ្សេងទៀតរបស់អ្នកឡើយ**។

---

## ១. បញ្ជីទីតាំង និងទំហំ Disk ដែលប្រើប្រាស់ (Disk Footprint Inventory)

### ក. ឯកសារបណ្ដោះអាសន្ន និងម៉ូដែលសាកល្បងដែលលែងប្រើ (~9.7 GB)
| ទីតាំង / ធនធាន | ទំហំបច្ចុប្បន្ន | តួនាទី | លុបបានឬទេ? |
| :--- | :---: | :--- | :--- |
| `~/.cache/huggingface/hub/` (10 benchmark repos)* | `~9.39 GB` (`8,955 MiB`) | ម៉ូដែល ASR សាកល្បង (`omniASR-CTC-1B`, `metythorn/whisper-large-v3-turbo`, `Vagabond404/khmer-asr-sota`, `whisper-small-khmer-v2`, `khmer-dictionary-44k`, stubs) | **លុបបានភ្លាម** — App នៅដើរធម្មតា |
| `/tmp/voxcpm-media-jobs` | `273 MB` | វីដេអូ Upload និង Export MP4 ចាស់ៗ | **លុបបានភ្លាម** |
| `/tmp/test_*`, `/tmp/tiktok_*`, `/tmp/burned_*`, `/tmp/kmwiktionary*.bz2` | `~18 MB` | ឯកសារតេស្តសំឡេង/រូបភាព និង Wiktionary raw dump | **លុបបានភ្លាម** |
| `logs/*.log` | `~408 KB` | Log របស់ Engine & Media Services | កាត់ឱ្យទទេបាន |
| Docker dangling layers (`<none>`) | `~1 MB+` | Image layers ចាស់ពេល Rebuild container | **លុបបានភ្លាម** |

*\*`seanghay/khmer-dictionary-44k` និង `phonsobon/khmer-english-spellchecker` ត្រូវបានបញ្ចូលរួចហើយទៅក្នុង `media/lexicon/formal_dictionary.tsv` (54,106 ពាក្យ ទំហំ 3.7 MB ក្នុង Repo) ដូច្នេះមិនត្រូវការ Raw cache ទៀតទេ។*

### ខ. ប្រព័ន្ធស្នូលដែលកំពុងដំណើរការ Voice Studio (~14.2 GB)
| ប្រភេទ | ទីតាំង / ឈ្មោះ | ទំហំ | កំណត់ចំណាំ |
| :--- | :--- | :---: | :--- |
| **Active HuggingFace Models** | `openbmb/VoxCPM2` (`5.0 GB`), `facebook/nllb-200-distilled-600M` (`2.5 GB`), `mlx-community/whisper-large-v3-turbo` (`1.6 GB`), `seanghay/Qwen3-ASR-0.6B-Khmer` (`1.6 GB`) | `~10.7 GB` | លុបតាម `media/cleanup_cache.py` ដោយប្រើ HuggingFace revision/blob tracking |
| **ModelScope Denoiser** | `~/.cache/modelscope/hub/models/iic/speech_zipenhancer_ans_multiloss_16k_base` | `18 MB` | សម្អាតសំឡេង Reference audio ក្នុង `engine/` |
| **Diarization & GTCRN** | `~/.cache/voxcpm-media/diarization` | `35 MB` | Pyannote + 3D-Speaker + GTCRN ONNX |
| **Python Environments** | `engine/.venv` (`1.4 GB`), `media/.venv` (`1.3 GB`) | `2.7 GB` | បង្កើតឡើងវិញបានតាម `uv sync --frozen --python 3.12` |
| **Web Build & Node** | `web/node_modules` (`40 MB`), `web/dist` | `~40 MB` | បង្កើតឡើងវិញបានតាម `npm ci` |
| **macOS Background Services** | `~/Library/LaunchAgents/com.voxcpm.engine.plist`, `com.voxcpm.media.plist` | `< 4 KB` | ត្រូវ `launchctl bootout` មុនលុប `.plist` |
| **Docker Images & Volume** | `voxcpm-voice-studio-storage` (`645 MB`), `voxcpm-voice-studio-studio` (`62.8 MB`), Volume `voxcpm_voice_studio_data` (`~70 MB`) | `~778 MB` | **Volume ផ្ទុក Character & Locked Voices** — លុបតែពេលប្រើ `--all` |

> **ការពារសុវត្ថិភាព Project ផ្សេងទៀត៖** `cleanup.sh` និង `media/cleanup_cache.py` លុបតែ Repo IDs និង Docker resources របស់ `project-text-to-voice` ប៉ុណ្ណោះ — **មិនប៉ះពាល់** ម៉ូដែលផ្សេងក្នុង `~/.cache/huggingface/hub` (`ACE-Step`, `Qwen3-TTS`, `faster-whisper-base`, `mms-tts-khm` ។ល។) ឬ Container ផ្សេងដូចជា `storeflow-*` ឡើយ។

---

## ២. របៀបប្រើប្រាស់ Script (`./cleanup.sh` ឬ `./studio.sh cleanup`)

### ជំហានទី ១ — ពិនិត្យមើលជាមុនដោយមិនទាន់លុប (`--dry-run`)
```sh
./cleanup.sh --unused --dry-run
./cleanup.sh --app --dry-run
./cleanup.sh --all --dry-run
```

### ជំហានទី ២ — ជ្រើសរើសកម្រិតលុបតាមតម្រូវការ

1. **បោសសម្អាតរបស់លែងប្រើ តែរក្សា App ឱ្យដើរធម្មតា (~9.7 GB freed):**
   ```sh
   ./cleanup.sh --unused
   ```
   *(លុបតែ Benchmark models ចាស់ៗ, `/tmp/voxcpm-media-jobs`, `/tmp/` test files, កាត់ log, និង dangling Docker layers)*

2. **លុបកម្មវិធី, LaunchAgents, Docker, Venv និង AI Models ទាំងអស់ តែ *រក្សាទុក* សំឡេង Character ដែលបាន Save (`--app`):**
   ```sh
   ./cleanup.sh --app
   ```
   *(ប្រសិនបើថ្ងៃក្រោយចង់ប្រើវិញ គ្រាន់តែរត់ `uv sync` + `./studio.sh start` នោះ Character ក្នុង `voxcpm_voice_studio_data` នៅតែមានដដែល)*

3. **លុបចោលទាំងស្រុង ១០០% រួមទាំង Database/សំឡេង Character (`--all`):**
   ```sh
   ./cleanup.sh --all
   # រួចចេញពី Folder ហើយលុប Source code ប្រសិនបើលែងត្រូវការប្រើ៖
   # cd .. && rm -rf project-text-to-voice
   ```
   *(បន្ថែម `--yes` ប្រសិនបើចង់រំលងសំណួរ confirm `[y/N]`)*

---

## ៣. វិធីលុបដោយដៃ (ប្រសិនបើបានលុប Folder Project ចោលមុនបាត់ហើយ)

ប្រសិនបើអ្នកបានលុប Folder `project-text-to-voice` ដោយដៃមុនពេលរត់ `./cleanup.sh` អាចសម្អាតសេសសល់តាម Command ខាងក្រោម៖

```sh
# 1. បិទ និងលុប macOS LaunchAgents
launchctl bootout "gui/$(id -u)/com.voxcpm.engine" 2>/dev/null || true
launchctl bootout "gui/$(id -u)/com.voxcpm.media" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.voxcpm.engine.plist ~/Library/LaunchAgents/com.voxcpm.media.plist

# 2. លុប Docker containers, images និង volume របស់ VoxCPM Voice Studio តែប៉ុណ្ណោះ
docker rm -f voxcpm-voice-studio-studio-1 voxcpm-voice-studio-storage-1 2>/dev/null || true
docker rmi voxcpm-voice-studio-studio:latest voxcpm-voice-studio-storage:latest 2>/dev/null || true
docker volume rm voxcpm_voice_studio_data 2>/dev/null || true

# 3. លុប Cache ផ្សេងៗ
rm -rf ~/.cache/voxcpm-media ~/.cache/modelscope/hub/models/iic/speech_zipenhancer_ans_multiloss_16k_base /tmp/voxcpm-media-jobs
```
