/* 我的日记 — 渲染进程
 *
 * 数据层与原版「一本日记」1.30.0 完全一致：
 *   - 同一个 IndexedDB 数据库名 "diary"，同样的 Dexie 版本号与索引声明
 *   - 同样的 userData 目录（由主进程 app.setPath 指向 %APPDATA%\一本日记）
 *   - images / localImages / tag 均为 "|" 分隔字符串
 * 任何一处不一致都会导致 Dexie 抛 VersionError 或写坏原版能读的数据。
 */

const { createApp, ref, computed, watch, onMounted, nextTick } = Vue;

/* ======================= 数据层 ======================= */

// 库结构声明来自 src/schema.js（与 tools/ 下的测试脚本共用同一份，避免抄本漂移）
const db = MYDIARY_SCHEMA.apply(new Dexie(MYDIARY_SCHEMA.DB_NAME));

const SEP = '|';

function uid() {
  let s = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 20; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function splitSep(v) {
  if (!v) return [];
  if (Array.isArray(v)) return v.filter(Boolean);
  return String(v)
    .split(SEP)
    .map((x) => x.trim())
    .filter(Boolean);
}

/* 按 uuid 建索引：整表读一次，替代合并时对每条远端记录做一次 where('uuid').equals()。
 * 取首个命中，与原先 .first() 的语义一致（uuid 本不该重复）。
 */
async function indexByUuid(table) {
  const map = new Map();
  for (const r of await table.toArray()) {
    if (r.uuid && !map.has(r.uuid)) map.set(r.uuid, r);
  }
  return map;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}
function tsToDateInput(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function dateInputToTs(str, keepTimeFrom) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str || '');
  if (!m) return keepTimeFrom || Date.now();
  const base = new Date(keepTimeFrom || Date.now());
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), base.getHours(), base.getMinutes(), base.getSeconds());
  return d.getTime();
}
function fmtDate(ts) {
  const d = new Date(ts || 0);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtTime(ts) {
  const d = new Date(ts || 0);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ======================= 应用 ======================= */

createApp({
  setup() {
    const dbError = ref('');
    const view = ref('list');
    const notice = ref(null);
    const search = ref('');

    const diaries = ref([]);
    const categories = ref([]);
    const tags = ref([]);

    const current = ref(null);
    const editing = ref(null);
    const editDate = ref('');
    const editTags = ref('');
    const editImages = ref([]);
    const preview = ref(false);
    // 已保存状态的签名，用来判断编辑器里有没有未保存的改动
    let savedSignature = '';
    // 打开时数据库里的 localImages，与本次会话新建的图片文件一起构成"可以安全删掉"的判定基线
    let editBaseline = [];
    let sessionImages = [];

    const filterCategory = ref('');
    const filterTag = ref('');

    const dataPath = ref('');
    const filePicker = ref(null);

    const calYear = ref(new Date().getFullYear());
    const calMonth = ref(new Date().getMonth() + 1);
    const dayFilter = ref('');

    const chartYear = ref(null);
    const chartMonth = ref(null);
    const chartCat = ref(null);

    const dav = ref({
      customUrl: '',
      username: '',
      password: '',
      selfSigned: false,
      lastSync: '',
      lastError: '',
      lastSnapshot: ''
    });
    const davPendingImages = ref(0);
    // 同步进行中：编辑页的同步按钮据此禁用并显示"同步中…"
    const syncing = ref(false);
    let syncQueued = false;

    const md = window.markdownit({ html: false, linkify: true, breaks: true });
    const rendered = computed(() => (editing.value ? md.render(editing.value.content || '') : ''));

    function toast(text, kind = 'info') {
      notice.value = { text, kind };
      setTimeout(() => {
        if (notice.value && notice.value.text === text) notice.value = null;
      }, 4000);
    }

    /* ---------- 应用内弹窗 ----------
     * Electron 不支持 window.prompt（调用即抛 "prompt() is and will not be supported."），
     * window.confirm 也不可靠，所以统一用自绘弹窗。
     */
    const dialog = ref(null);
    let dialogResolve = null;

    function openDialog(spec) {
      return new Promise((resolve) => {
        dialogResolve = resolve;
        dialog.value = spec;
        nextTick(() => {
          const el = document.querySelector('.modal input');
          if (el) { el.focus(); el.select(); }
        });
      });
    }
    function askText(title, value, hint, okText) {
      return openDialog({ kind: 'text', title, value: value || '', hint: hint || '', okText: okText || '确定' });
    }
    function askConfirm(title, hint, okText) {
      return openDialog({ kind: 'confirm', title, value: '', hint: hint || '', okText: okText || '确定' });
    }
    function dialogOk() {
      const d = dialog.value;
      const value = d && d.kind === 'text' ? d.value : true;
      dialog.value = null;
      if (dialogResolve) { dialogResolve(value); dialogResolve = null; }
    }
    function dialogCancel() {
      const d = dialog.value;
      const value = d && d.kind === 'text' ? null : false;
      dialog.value = null;
      if (dialogResolve) { dialogResolve(value); dialogResolve = null; }
    }

    /* ---------- 加载 ---------- */

    async function loadAll() {
      const all = (await db.diary.toArray()).filter((d) => !d.deleted);
      all.sort((a, b) => (b.recordTime || b.createTime || 0) - (a.recordTime || a.createTime || 0));
      diaries.value = all;

      categories.value = (await db.category.toArray())
        .filter((c) => !c.isDeleted)
        .sort((a, b) => (b.count || 0) - (a.count || 0));

      tags.value = (await db.tag.toArray())
        .filter((t) => !t.deleted)
        .sort((a, b) => (a.order || 0) - (b.order || 0));
    }

    async function openDb() {
      dbError.value = '';
      try {
        await db.open();
        await loadAll();
      } catch (e) {
        dbError.value = (e && e.message) || String(e);
      }
    }

    /* ---------- 派生列表 ---------- */

    const filteredDiaries = computed(() => {
      const kw = search.value.trim().toLowerCase();
      return diaries.value.filter((d) => {
        if (filterCategory.value && d.category !== filterCategory.value) return false;
        if (filterTag.value && splitSep(d.tag).indexOf(filterTag.value) === -1) return false;
        if (kw) {
          const hay = ((d.title || '') + '\n' + (d.content || '')).toLowerCase();
          if (hay.indexOf(kw) === -1) return false;
        }
        return true;
      });
    });

    const listTitle = computed(() => {
      const parts = [];
      if (filterCategory.value) parts.push(filterCategory.value);
      if (filterTag.value) parts.push('#' + filterTag.value);
      if (search.value.trim()) parts.push('搜索「' + search.value.trim() + '」');
      return parts.length ? parts.join(' · ') : '全部日记';
    });

    /* ---------- 列表辅助 ---------- */

    function plain(content) {
      return String(content || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#>*`_~\-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function firstLine(content) {
      const line = String(content || '').split('\n').find((l) => l.trim());
      return plain(line || '').slice(0, 40);
    }
    function splitTags(v) {
      return splitSep(v);
    }

    /* ---------- 编辑器 ---------- */

    function blankDiary() {
      const now = Date.now();
      const d = new Date(now);
      return {
        title: '',
        content: '',
        createTime: now,
        updateTime: now,
        recordTime: now,
        images: '',
        localImages: '',
        city: '',
        address: '',
        temperature: '',
        weather: '',
        color: '',
        dayOfMonth: d.getDate(),
        monthOfYear: d.getMonth() + 1,
        year: d.getFullYear(),
        latitude: '',
        longitude: '',
        deleted: 0,
        uuid: uid(),
        synced: 1,
        isSynced: 1,
        isHidden: 0,
        device: '',
        category: '',
        type: '',
        audio: '',
        localAudio: '',
        contentType: 0,
        tag: '',
        top: 0
      };
    }

    /* 编辑器脏检查：切换日记会直接覆盖 editing，之前未保存的改动会静默消失。
     * 签名只取真正会写进数据库的字段，preview 之类的纯界面状态不算改动。
     */
    function signature() {
      const e = editing.value;
      if (!e) return '';
      return JSON.stringify([
        e.title || '',
        e.content || '',
        e.weather || '',
        e.address || '',
        e.category || '',
        editDate.value,
        editTags.value,
        editImages.value
      ]);
    }
    function isDirty() {
      return !!editing.value && signature() !== savedSignature;
    }

    async function dropFiles(names) {
      for (const n of names) {
        try { await window.fileApi.deleteImage(n); } catch (e) { /* 文件已不在，忽略 */ }
      }
    }

    // 本次会话新建、但最终没被保存引用的图片文件是孤儿，放弃编辑时要一并清掉
    async function discardSessionImages() {
      const names = sessionImages;
      sessionImages = [];
      await dropFiles(names);
    }

    // 返回 false 表示用户选择留下继续编辑
    async function confirmDiscard() {
      if (!isDirty()) return true;
      if (!(await askConfirm('放弃未保存的修改？', '这篇日记改动过但还没保存。', '放弃'))) return false;
      await discardSessionImages();
      return true;
    }

    function startBlank() {
      editing.value = blankDiary();
      editDate.value = tsToDateInput(editing.value.recordTime);
      editTags.value = '';
      editImages.value = [];
      editBaseline = [];
      sessionImages = [];
      savedSignature = signature();
      preview.value = false;
      current.value = null;
      view.value = 'list';
    }

    async function newDiary() {
      if (!(await confirmDiscard())) return;
      startBlank();
    }

    async function openDiary(d) {
      if (!(await confirmDiscard())) return;
      current.value = d;
      editing.value = Object.assign({}, d);
      editDate.value = tsToDateInput(d.recordTime || d.createTime);
      editTags.value = splitSep(d.tag).join(', ');
      editImages.value = splitSep(d.localImages);
      editBaseline = editImages.value.slice();
      sessionImages = [];
      savedSignature = signature();
      preview.value = false;
      view.value = 'list';
    }

    function togglePreview() {
      preview.value = !preview.value;
    }

    /* 保存成功后清掉不再被引用的本地图片文件。
     * 基线 = 打开时库里的 localImages + 本次会话新建的文件，减去最终保留的，
     * 剩下的就是孤儿。以前 removeImage 只把它从数组里摘掉，images/ 目录只增不减。
     */
    async function pruneImages() {
      const keep = new Set(editImages.value);
      const gone = [...new Set([...editBaseline, ...sessionImages])].filter((n) => !keep.has(n));
      await dropFiles(gone);
    }

    async function saveDiary() {
      const e = editing.value;
      if (!e) return;
      if (!(e.title || '').trim() && !(e.content || '').trim() && !editImages.value.length) {
        toast('内容为空，未保存', 'err');
        return;
      }

      e.recordTime = dateInputToTs(editDate.value, e.recordTime);
      const d = new Date(e.recordTime);
      e.year = d.getFullYear();
      e.monthOfYear = d.getMonth() + 1;
      e.dayOfMonth = d.getDate();

      e.updateTime = Date.now();
      e.tag = editTags.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(SEP);
      e.localImages = editImages.value.join(SEP);
      e.deleted = e.deleted ? 1 : 0;
      e.isHidden = e.isHidden ? 1 : 0;
      // 保持 synced/isSynced = 1：原版看到 0 会把这条上传到厂商云端
      e.synced = 1;
      e.isSynced = 1;

      const record = Object.assign({}, e);
      delete record.id;

      try {
        if (current.value && current.value.id != null) {
          await db.diary.update(current.value.id, record);
        } else {
          const id = await db.diary.add(record);
          record.id = id;
        }
        await refreshCategoryCounts();
        await loadAll();
        const saved = diaries.value.find((x) => x.uuid === record.uuid);
        if (saved) {
          current.value = saved;
          editing.value = Object.assign({}, saved);
          editDate.value = tsToDateInput(saved.recordTime || saved.createTime);
          editTags.value = splitSep(saved.tag).join(', ');
          editImages.value = splitSep(saved.localImages);
        }
        await pruneImages();
        editBaseline = editImages.value.slice();
        sessionImages = [];
        savedSignature = signature();
        toast('已保存', 'ok');
        // 保存后自动同步（默认开，可在设置页关掉）；失败会自己提示，不影响"已保存"
        await maybeAutoSync();
      } catch (err) {
        toast('保存失败：' + ((err && err.message) || err), 'err');
      }
    }

    async function deleteDiary() {
      if (!current.value || current.value.id == null) {
        if (!(await askConfirm('丢弃这篇还没保存的日记？', '内容尚未写入数据库。', '丢弃'))) return;
        await discardSessionImages();
        current.value = null;
        editing.value = null;
        savedSignature = '';
        return;
      }
      if (!(await askConfirm('删除这篇日记？', '标记为已删除，同步时会把删除一并传给手机端。', '删除'))) return;
      // 本次会话新加、还没保存进任何记录的图片文件是孤儿：记录都删了，没人再引用它们
      await discardSessionImages();
      try {
        // 官方格式靠 deleted 标志 + uuid 当墓碑。硬删除的话远端仍留着这条记录，
        // 下次同步 mergeRemote 按 uuid 查不到本地就会把它重新插回来——删掉的日记复活。
        await db.diary.update(current.value.id, {
          deleted: 1,
          updateTime: Date.now(),
          synced: 1,
          isSynced: 1
        });
        current.value = null;
        editing.value = null;
        savedSignature = '';
        await refreshCategoryCounts();
        await loadAll();
        toast('已删除', 'ok');
      } catch (err) {
        toast('删除失败：' + ((err && err.message) || err), 'err');
      }
    }

    /* ---------- 图片 ---------- */

    function imgSrc(name) {
      if (!name) return '';
      if (/^(https?:|data:|file:)/.test(name)) return name;
      return window.fileApi.getImageUrl(name);
    }

    function pickImage() {
      if (filePicker.value) filePicker.value.click();
    }

    function trackImage(name) {
      if (!name) return;
      editImages.value.push(name);
      sessionImages.push(name);
    }

    // 扩展名一律收敛成 whitelist 形状的小写形式再交给主进程
    function safeExt(ext) {
      return /^\.[A-Za-z0-9]{1,5}$/.test(ext || '') ? ext.toLowerCase() : '.jpeg';
    }

    async function onFilePicked(ev) {
      const files = Array.from(ev.target.files || []);
      for (const f of files) {
        try {
          if (f.path) {
            trackImage(await window.fileApi.saveImage(f.path));
          } else {
            const buf = await f.arrayBuffer();
            // 直接传 Uint8Array：结构化克隆本来就支持，转成普通数组会把大截图白拷一遍
            trackImage(await window.fileApi.saveImageBuffer(new Uint8Array(buf), safeExt('.' + (f.name.split('.').pop() || 'jpeg'))));
          }
        } catch (e) {
          // 主进程会挡掉不存在/非图片的来源，必须报出来，否则就是"点了一下没反应"
          toast('图片添加失败：' + ((e && e.message) || e), 'err');
        }
      }
      ev.target.value = '';
    }

    async function onPaste(ev) {
      const items = (ev.clipboardData && ev.clipboardData.items) || [];
      for (const it of items) {
        if (it.type && it.type.indexOf('image') === 0) {
          ev.preventDefault();
          const file = it.getAsFile();
          if (!file) continue;
          try {
            const buf = await file.arrayBuffer();
            trackImage(await window.fileApi.saveImageBuffer(new Uint8Array(buf), safeExt('.' + (it.type.split('/')[1] || 'jpeg'))));
          } catch (e) {
            toast('粘贴图片失败：' + ((e && e.message) || e), 'err');
          }
        }
      }
    }

    function removeImage(name) {
      editImages.value = editImages.value.filter((x) => x !== name);
    }

    /* ---------- 分类 / 标签 ---------- */

    async function refreshCategoryCounts() {
      await db.transaction('rw', db.diary, db.category, async () => {
        const counter = {};
        // 已删除的记录不计入分类计数（loadAll 也不会把它们列出来）
        for (const d of await db.diary.toArray()) {
          if (d.deleted || !d.category) continue;
          counter[d.category] = (counter[d.category] || 0) + 1;
        }
        const cats = await db.category.toArray();
        await Promise.all(
          cats
            .filter((c) => (c.count || 0) !== (counter[c.name] || 0))
            .map((c) => db.category.update(c.id, { count: counter[c.name] || 0 }))
        );
      });
    }

    async function addCategory() {
      const name = await askText('新建分类', '', '例如：工作 / 生活 / 学习');
      if (!name || !name.trim()) return;
      const n = name.trim();
      if (categories.value.some((c) => c.name === n)) {
        toast('分类已存在', 'err');
        return;
      }
      // 同名分类可能还有一条墓碑（isDeleted=1 的行不会从库里消失）。
      // 直接 add 会造出同名的第二行：本地看不出来，但全量上传后对端就有两个同名分类，
      // 而且它们 uuid 不同、永远不会被合并。复活旧行才对。
      const dead = await db.category.where('name').equals(n).filter((c) => !!c.isDeleted).first();
      if (dead) {
        await db.category.update(dead.id, { isDeleted: 0, updateTime: Date.now(), synced: 1 });
      } else {
        await db.category.add({
          name: n,
          count: 0,
          pic: '',
          isDeleted: 0,
          uuid: uid(),
          recordModelId: '',
          createTime: Date.now(),
          updateTime: Date.now(),
          synced: 1
        });
      }
      await refreshCategoryCounts();
      await loadAll();
    }

    async function removeCategory(c) {
      if (!(await askConfirm(`删除分类「${c.name}」？`, '日记本身不会被删除，只是取消归类。', '删除'))) return;
      const now = Date.now();
      await db.transaction('rw', db.diary, db.category, async () => {
        await db.category.update(c.id, { isDeleted: 1, updateTime: now, synced: 1 });
        const affected = (await db.diary.toArray()).filter((d) => !d.deleted && d.category === c.name);
        if (affected.length) {
          await db.diary.bulkPut(
            affected.map((d) => Object.assign({}, d, { category: '', updateTime: now, synced: 1, isSynced: 1 }))
          );
        }
      });
      if (filterCategory.value === c.name) filterCategory.value = '';
      await loadAll();
    }

    async function addTag() {
      const name = await askText('新建标签', '', '例如：旅行 / 灵感 / 待办');
      if (!name || !name.trim()) return;
      const n = name.trim();
      if (tags.value.some((t) => t.name === n)) {
        toast('标签已存在', 'err');
        return;
      }
      // 和分类一样：同名标签的墓碑行要复活，不要新建一条同名的
      const dead = await db.tag.where('name').equals(n).filter((t) => !!t.deleted).first();
      if (dead) {
        await db.tag.update(dead.id, { deleted: 0, updateTime: Date.now(), synced: 1 });
      } else {
        await db.tag.add({
          name: n,
          deleted: 0,
          uuid: uid(),
          order: tags.value.length,
          lock: 0,
          createTime: Date.now(),
          updateTime: Date.now(),
          synced: 1
        });
      }
      await loadAll();
    }

    async function removeTag(t) {
      if (!(await askConfirm(`删除标签「${t.name}」？`, '', '删除'))) return;
      await db.tag.update(t.id, { deleted: 1, updateTime: Date.now(), synced: 1 });
      if (filterTag.value === t.name) filterTag.value = '';
      await loadAll();
    }

    /* ---------- 日历 ---------- */

    const monthDiaries = computed(() =>
      diaries.value.filter((d) => {
        const dt = new Date(d.recordTime || d.createTime || 0);
        return dt.getFullYear() === calYear.value && dt.getMonth() + 1 === calMonth.value;
      })
    );

    const calendarCells = computed(() => {
      const first = new Date(calYear.value, calMonth.value - 1, 1);
      const daysInMonth = new Date(calYear.value, calMonth.value, 0).getDate();
      const lead = first.getDay();
      const counts = {};
      monthDiaries.value.forEach((d) => {
        const day = new Date(d.recordTime || d.createTime).getDate();
        counts[day] = (counts[day] || 0) + 1;
      });
      const today = new Date();
      const cells = [];
      for (let i = 0; i < lead; i++) cells.push({ day: 0, count: 0, date: '' });
      for (let d = 1; d <= daysInMonth; d++) {
        const date = `${calYear.value}-${pad2(calMonth.value)}-${pad2(d)}`;
        cells.push({
          day: d,
          count: counts[d] || 0,
          date,
          isToday:
            today.getFullYear() === calYear.value &&
            today.getMonth() + 1 === calMonth.value &&
            today.getDate() === d
        });
      }
      return cells;
    });

    const dayDiaries = computed(() => {
      if (!dayFilter.value) return [];
      return diaries.value.filter((d) => fmtDate(d.recordTime || d.createTime) === dayFilter.value);
    });

    function shiftMonth(delta) {
      let m = calMonth.value + delta;
      let y = calYear.value;
      if (m < 1) {
        m = 12;
        y--;
      } else if (m > 12) {
        m = 1;
        y++;
      }
      calMonth.value = m;
      calYear.value = y;
      dayFilter.value = '';
    }

    function selectDay(cell) {
      dayFilter.value = dayFilter.value === cell.date ? '' : cell.date;
    }

    /* ---------- 统计 ---------- */

    const totalWords = computed(() =>
      diaries.value.reduce((sum, d) => sum + String(d.content || '').replace(/\s/g, '').length, 0)
    );

    const writingDays = computed(() => {
      const set = new Set(diaries.value.map((d) => fmtDate(d.recordTime || d.createTime)));
      return set.size;
    });

    const streak = computed(() => {
      const set = new Set(diaries.value.map((d) => fmtDate(d.recordTime || d.createTime)));
      const cur = new Date();
      // 今天还没写不算断，从昨天起算
      if (!set.has(fmtDate(cur.getTime()))) cur.setDate(cur.getDate() - 1);
      let n = 0;
      while (set.has(fmtDate(cur.getTime()))) {
        n++;
        cur.setDate(cur.getDate() - 1);
      }
      return n;
    });

    let charts = [];
    function disposeCharts() {
      charts.forEach((c) => c && c.dispose && c.dispose());
      charts = [];
    }

    function renderCharts() {
      disposeCharts();
      if (!window.echarts) return;

      const byYear = {};
      diaries.value.forEach((d) => {
        const y = new Date(d.recordTime || d.createTime || 0).getFullYear();
        byYear[y] = (byYear[y] || 0) + 1;
      });
      const years = Object.keys(byYear).sort();
      if (chartYear.value) {
        const c = window.echarts.init(chartYear.value);
        c.setOption({
          title: { text: '每年篇数', textStyle: { fontSize: 13 } },
          grid: { left: 40, right: 20, top: 40, bottom: 30 },
          xAxis: { type: 'category', data: years.length ? years : ['暂无'] },
          yAxis: { type: 'value', minInterval: 1 },
          series: [{ type: 'bar', data: years.map((y) => byYear[y]), itemStyle: { color: '#4a7cf7' }, barMaxWidth: 40 }]
        });
        charts.push(c);
      }

      const byMonth = new Array(12).fill(0);
      diaries.value.forEach((d) => {
        const dt = new Date(d.recordTime || d.createTime || 0);
        if (dt.getFullYear() === new Date().getFullYear()) byMonth[dt.getMonth()]++;
      });
      if (chartMonth.value) {
        const c = window.echarts.init(chartMonth.value);
        c.setOption({
          title: { text: `${new Date().getFullYear()} 年每月篇数`, textStyle: { fontSize: 13 } },
          grid: { left: 40, right: 20, top: 40, bottom: 30 },
          xAxis: { type: 'category', data: byMonth.map((_, i) => i + 1 + '月') },
          yAxis: { type: 'value', minInterval: 1 },
          series: [{ type: 'line', data: byMonth, smooth: true, areaStyle: { opacity: 0.15 }, itemStyle: { color: '#4a7cf7' } }]
        });
        charts.push(c);
      }

      const byCat = {};
      diaries.value.forEach((d) => {
        const k = d.category || '未分类';
        byCat[k] = (byCat[k] || 0) + 1;
      });
      if (chartCat.value) {
        const c = window.echarts.init(chartCat.value);
        c.setOption({
          title: { text: '分类分布', textStyle: { fontSize: 13 } },
          series: [
            {
              type: 'pie',
              radius: ['40%', '68%'],
              data: Object.keys(byCat).map((k) => ({ name: k, value: byCat[k] }))
            }
          ]
        });
        charts.push(c);
      }
    }

    watch(view, (v) => {
      if (v === 'stats') nextTick(renderCharts);
      else disposeCharts();
    });

    /* ---------- 备份 ---------- */

    function currentUserId() {
      return localStorage.getItem('b') || 'local';
    }

    function buildBackupObject() {
      return {
        diaryList: diaries.value,
        categoryList: categories.value,
        modelList: [],
        tagList: tags.value
      };
    }

    async function exportBackup() {
      await loadAll();
      // 名字来自共享 localStorage（原版用户 id / sync_type），当不可信输入处理：
      // 去掉路径分隔符等字符，主进程还会再校验一次 basename。
      const name =
        (currentUserId() + (localStorage.getItem('sync_type') || 1)).replace(/[\\/:*?"<>|\s]/g, '') || 'local1';
      const ok = await window.fileApi.saveData(name, JSON.stringify(buildBackupObject()));
      toast(ok ? `已写入 data/${name}（与原版备份格式一致）` : '写入失败', ok ? 'ok' : 'err');
    }

    async function importBackup() {
      const files = await window.fileApi.listDataFiles();
      if (!files.length) {
        toast('data/ 目录下没有备份文件', 'err');
        return;
      }
      let name = files[0];
      if (files.length > 1) {
        name = await askText('选择要导入的备份文件', files[0], 'data/ 目录下：' + files.join('、'));
        if (!name) return;
      }
      const text = await window.fileApi.getData(name);
      if (!text) {
        toast('读取或解密失败', 'err');
        return;
      }
      await mergeBackup(JSON.parse(text), '备份文件 ' + name);
    }

    async function exportJson() {
      await loadAll();
      const p = await window.fileApi.exportTextFile(
        `我的日记-${fmtDate(Date.now())}.json`,
        JSON.stringify(buildBackupObject(), null, 2)
      );
      if (p) toast('已导出到 ' + p, 'ok');
    }

    async function importJson() {
      const text = await window.fileApi.importTextFile();
      if (!text) return;
      await mergeBackup(JSON.parse(text), 'JSON 文件');
    }

    async function mergeBackup(obj, sourceLabel) {
      const list = obj.diaryList || [];
      const cats = obj.categoryList || [];
      const tgs = obj.tagList || [];
      if (!list.length) {
        toast(sourceLabel + ' 中没有日记', 'err');
        return;
      }
      if (!(await askConfirm(
        `从 ${sourceLabel} 导入 ${list.length} 篇日记、${cats.length} 个分类、${tgs.length} 个标签？`,
        '同 uuid 的记录按 updateTime 取新。',
        '导入'
      ))) return;

      let added = 0, updated = 0;
      // 整个导入放在一个事务里：中途失败不会留下半导入状态
      await db.transaction('rw', db.diary, db.category, db.tag, async () => {
        const localDiaries = await indexByUuid(db.diary);
        const diaryWrites = [];
        for (const rec of list) {
          const r = Object.assign({}, rec);
          delete r.id;
          r.synced = 1;
          r.isSynced = 1;
          const old = r.uuid ? localDiaries.get(r.uuid) : null;
          if (old) {
            if ((r.updateTime || 0) > (old.updateTime || 0)) {
              diaryWrites.push(Object.assign({}, old, r, { id: old.id }));
              updated++;
            }
          } else {
            diaryWrites.push(r);
            added++;
          }
        }
        if (diaryWrites.length) await db.diary.bulkPut(diaryWrites);

        const catNames = new Set((await db.category.toArray()).map((c) => c.name));
        const newCats = cats
          .filter((c) => !catNames.has(c.name))
          .map((c) => { const r = Object.assign({}, c); delete r.id; r.synced = 1; return r; });
        if (newCats.length) await db.category.bulkAdd(newCats);

        const tagNames = new Set((await db.tag.toArray()).map((t) => t.name));
        const newTags = tgs
          .filter((t) => !tagNames.has(t.name))
          .map((t) => { const r = Object.assign({}, t); delete r.id; r.synced = 1; return r; });
        if (newTags.length) await db.tag.bulkAdd(newTags);
      });

      await refreshCategoryCounts();
      await loadAll();
      toast(`导入完成：新增 ${added}、更新 ${updated}`, 'ok');
    }

    /* ---------- WebDAV：原版《一本日记》第三方同步协议 ---------- */

    const DAV_KEY = 'mydiary_webdav';
    const SYNC_DATA_VERSION = 1;
    /* 云端序列化格式的版本号：任何会改变 diary.json 里字节形状的改动都要 +1
     * （比如把 isSynced 改成布尔，那一次没加，结果修好的格式因为"本地数据没变"
     * 被水位线判成"无需同步"，永远推不上去——手机端一直读到旧的坏 payload）。
     * 水位线只能证明"本地数据没变"，证明不了"我们发出去的字节没变"。
     *
     * 2：isSynced 改布尔（手机端 Gson 要求）
     * 3：删掉为空的 latitude / longitude / temperature（手机端按 double 解析，空串会抛
     *    NumberFormatException("empty String")）
     */
    const REMOTE_FORMAT = 3;

    function loadDav() {
      let fromStore = false;
      try {
        const raw = localStorage.getItem(DAV_KEY);
        if (raw) {
          dav.value = Object.assign(dav.value, JSON.parse(raw));
          fromStore = true;
        }
      } catch (e) { /* 忽略损坏的配置 */ }

      // 首次使用：原版 PC 端如果配过第三方同步（它的 sync_type=4 即自定义 WebDAV），
      // 直接沿用它的地址和账号，省得重输。localStorage 与原版共用，
      // wd_url / auth 就是原版存的位置。
      if (!fromStore) {
        try {
          if (Number(localStorage.getItem('sync_type') || 0) === 4) {
            dav.value.customUrl = localStorage.getItem('wd_url') || '';
            const m = /^Basic\s+(.+)$/i.exec(localStorage.getItem('auth') || '');
            if (m) {
              const dec = atob(m[1]);
              const i = dec.indexOf(':');
              if (i >= 0) {
                dav.value.username = dec.slice(0, i);
                dav.value.password = dec.slice(i + 1);
              }
            }
          }
        } catch (e) { /* atob 失败等一律忽略 */ }
      }

      // 保存后自动同步默认开启。老配置里没有这一项，靠 undefined 判断会让复选框
      // 显示成未勾选、而行为却是开启，所以补一个明确的值。
      if (dav.value.autoSync === undefined) dav.value.autoSync = true;
    }
    function davSave() {
      const cfg = Object.assign({}, dav.value);
      delete cfg.lastSync;
      delete cfg.lastError;
      localStorage.setItem(DAV_KEY, JSON.stringify(cfg));
      toast('WebDAV 配置已保存', 'ok');
    }
    function davCfg() {
      return {
        customUrl: dav.value.customUrl,
        username: dav.value.username,
        password: dav.value.password,
        selfSigned: !!dav.value.selfSigned
      };
    }
    const davBase = computed(() => String(dav.value.customUrl || '').replace(/\/+$/, ''));
    function unwrap(res) {
      if (!res) throw new Error('无响应');
      if (!res.ok) throw new Error(res.error || '未知错误');
      return res.data;
    }

    function davConfigured() {
      return !!(String(dav.value.customUrl || '').trim() && String(dav.value.username || '').trim());
    }

    /* 同步串行化：要跑好几秒，编辑页按钮、设置页三个按钮、保存后自动同步
     * 都可能在同一时刻要求同步。正在跑就记一个"排队"，跑完再补一次，
     * 避免两个同步交叉执行、互相覆盖远端。
     */
    async function runSync(task) {
      if (syncing.value) { syncQueued = true; return; }
      syncing.value = true;
      try {
        await task();
      } finally {
        syncing.value = false;
      }
      if (syncQueued) {
        syncQueued = false;
        await runSync(task);
      }
    }

    /* 保存成功后自动同步。没配 WebDAV 就静默跳过；设置页可以关掉。
     * 失败不需要额外提示——syncNow 自己会把错误写进 lastError 并弹提示。
     */
    async function maybeAutoSync() {
      if (dav.value.autoSync === false) return;
      if (!davConfigured()) return;
      await runSync(syncNow);
    }

    /* --- 本地 -> 远端：布尔化，并把 category 挪到 type（与原版 b() 一致，只改副本） --- */

    /* 手机端把 latitude / longitude / temperature 当 double 解析：Android 的
     * StringToReal 对空串直接抛 NumberFormatException("empty String")，
     * 界面上就是"同步出错: EMPTY STRING"，整份云端数据都读不进去。
     * 本地这三项按 '' 存"没填"（见 blankDiary），原样发出去手机就崩。
     * 官方 PC 端从不构造这三个字段（asar 里 temperature 这个字面量都不存在，
     * latitude 只出现在 Dexie 的 schema 字符串里），手机自己上传的记录里也没有这几个键。
     * 所以空值一律删键：Gson 见到缺字段就当 null/0，与手机自己的行为一致。
     */
    const NUMERIC_FIELDS = ['latitude', 'longitude', 'temperature'];

    function toRemoteDiary(d) {
      const o = Object.assign({}, d);
      delete o.id;
      o.deleted = o.deleted == 1;
      o.isHidden = o.isHidden == 1;
      // isSynced 也必须转布尔：官方 PC 端的 b() 里根本没有这个字段（整个 asar 搜不到
      // "isSynced"），但手机端的模型把它声明成 boolean——手机自己上传的记录里就是 true。
      // 本地库按 0/1 存，原样发 1 会让手机端解析整份 diary.json 时直接抛
      // "java.lang.IllegalStateException: Expected a BOOLEAN but was NUMBER"，
      // 也就是手机上那句"同步出错"。
      o.isSynced = !!o.isSynced;
      for (const f of NUMERIC_FIELDS) {
        if (o[f] === null || o[f] === undefined || String(o[f]).trim() === '') delete o[f];
      }
      if (o.category) { o.type = o.category; o.category = ''; }
      return o;
    }
    function toRemoteCategory(c) {
      const o = Object.assign({}, c);
      delete o.id;
      o.isDeleted = o.isDeleted == 1;
      return o;
    }
    function toRemoteModel(m) {
      const o = Object.assign({}, m);
      delete o.id;
      o.isDelete = o.isDelete == 1;
      o.isDefault = o.isDefault == 1;
      return o;
    }
    function toRemoteTag(t) {
      const o = Object.assign({}, t);
      delete o.id;
      o.deleted = o.deleted == 1;
      o.lock = o.lock == 1;
      return o;
    }

    /* --- 远端 -> 本地：还原成 0/1 与 category（与官方格式一致） --- */
    function fromRemoteDiary(a) {
      const o = Object.assign({}, a);
      delete o.id;
      o.deleted = o.deleted ? 1 : 0;
      o.isHidden = o.isHidden ? 1 : 0;
      if (o.type) { o.category = o.type; o.type = ''; }
      o.synced = 1;
      o.isSynced = 1;
      return o;
    }
    function fromRemoteFlag(a, field) {
      const o = Object.assign({}, a);
      delete o.id;
      o[field] = o[field] ? 1 : 0;
      o.synced = 1;
      return o;
    }

    /* 一次上传的「水位线」：这次真正推上去的记录里最大的 updateTime。
     * 本地写库一律 synced=1（见 saveDiary 的注释），所以「本地还有没有没推上去的改动」
     * 不能看 synced，只能拿这个水位线和表里当前的 updateTime 比。
     * 水位线取自**这次真正上传的那批行**，而不是事后重新扫表：
     * 上传过程中用户新改的内容 updateTime 更大，不会被水位线盖掉，
     * 下次同步照样能发现「还有东西没推上去」。
     */
    function maxUpdateTime(rows) {
      let max = 0;
      for (const r of rows) {
        const u = Number(r.updateTime) || 0;
        if (u > max) max = u;
      }
      return max;
    }

    async function buildUpload() {
      const diaries = await db.diary.toArray();
      const cats = await db.category.toArray();
      const models = await db.recordModel.toArray();
      const tags = await db.tag.toArray();
      const payload = {
        // 注意：该键名固定为 "catagory"（就是这个拼写），不能写成 category
        json: JSON.stringify(diaries.map(toRemoteDiary)),
        catagory: JSON.stringify(cats.map(toRemoteCategory)),
        model: JSON.stringify(models.map(toRemoteModel)),
        tag: JSON.stringify(tags.map(toRemoteTag))
      };
      const stamp = Math.max(
        maxUpdateTime(diaries),
        maxUpdateTime(cats),
        maxUpdateTime(models),
        maxUpdateTime(tags)
      );
      return { payload, stamp };
    }

    async function buildRemotePayload() {
      return (await buildUpload()).payload;
    }

    /* 表里当前最新的 updateTime。没有水位线（第一次同步、或换了云盘账号）时一律当成
     * 「有改动要推」——宁可白推一次全量，也不能把本地改动判成"无需同步"。
     */
    async function localChangeStamp() {
      const rows = [
        ...(await db.diary.toArray()),
        ...(await db.category.toArray()),
        ...(await db.tag.toArray()),
        ...(await db.recordModel.toArray())
      ];
      return maxUpdateTime(rows);
    }

    function noteUploaded(stamp) {
      dav.value.lastUploadTs = stamp;
      dav.value.lastUploadFormat = REMOTE_FORMAT;
      davTouch();
    }

    /* 远端 diary.json 的四个键都是「再被 JSON.stringify 一次的字符串」。
     * 解析失败必须抛出来：以前是静默当成空数组，紧接着 syncNow 就用本地全量 PUT 覆盖远端，
     * 等于把读不出来的云端数据直接销毁，而且没有任何副本可回滚。
     */
    function parseRemoteList(obj, key, label) {
      const raw = obj ? obj[key] : undefined;
      if (raw === undefined || raw === null || raw === '') return [];
      let list;
      try {
        list = JSON.parse(raw);
      } catch (e) {
        throw new Error(`云端${label}数据损坏，无法解析（已中止，未覆盖远端）：${e.message}`);
      }
      if (!Array.isArray(list)) throw new Error(`云端${label}数据不是数组（已中止，未覆盖远端）`);
      return list;
    }

    async function mergeRemote(obj) {
      const remoteDiaries = parseRemoteList(obj, 'json', '日记');
      const remoteCats = parseRemoteList(obj, 'catagory', '分类');
      const remoteTags = parseRemoteList(obj, 'tag', '标签');
      const remoteModels = parseRemoteList(obj, 'model', '模板');

      let added = 0, updated = 0, skipped = 0;
      // 分类 / 标签 / 模板的合并结果单独计数，别混进日记的数字里（提示里分开说）
      const flagged = { added: 0, updated: 0 };

      // 整个合并放在一个事务里：四张表要么一起改完，要么都不改，不会留下半合并状态。
      // bulkPut 是整条替换，所以更新分支必须 Object.assign(local, 远端字段) 手动合并，
      // 才能保住远端没带的本地字段（isSynced / device / bt / m / ind 等），
      // 这与原先 db.xxx.update(id, patch) 的语义一致。
      await db.transaction('rw', db.diary, db.category, db.tag, db.recordModel, async () => {
        const mergeFlagged = async (table, remoteList, field) => {
          const locals = await indexByUuid(table);
          const writes = [];
          for (const a of remoteList) {
            const local = a.uuid ? locals.get(a.uuid) : null;
            if (local) {
              if ((local.updateTime || 0) < (a.updateTime || 0)) {
                writes.push(Object.assign({}, local, fromRemoteFlag(a, field), { id: local.id }));
                flagged.updated++;
              }
            } else if (!a[field]) {
              writes.push(fromRemoteFlag(a, field));
              flagged.added++;
            }
          }
          if (writes.length) await table.bulkPut(writes);
        };

        const localDiaries = await indexByUuid(db.diary);
        const diaryWrites = [];
        for (const a of remoteDiaries) {
          const local = a.uuid ? localDiaries.get(a.uuid) : null;
          if (local) {
            if ((local.updateTime || 0) < (a.updateTime || 0)) {
              diaryWrites.push(Object.assign({}, local, fromRemoteDiary(a), { id: local.id }));
              updated++;
            } else if ((local.updateTime || 0) === (a.updateTime || 0) && local.synced === 0) {
              diaryWrites.push(Object.assign({}, local, { synced: 1 }));
            }
          } else {
            // 远端已删除又没有历史版本的，不必在本地新建一条墓碑
            if (a.deleted && !(a.historyTime || 0)) { skipped++; continue; }
            diaryWrites.push(fromRemoteDiary(a));
            added++;
          }
        }
        if (diaryWrites.length) await db.diary.bulkPut(diaryWrites);

        await mergeFlagged(db.category, remoteCats, 'isDeleted');
        await mergeFlagged(db.tag, remoteTags, 'deleted');
        await mergeFlagged(db.recordModel, remoteModels, 'isDelete');
      });

      await loadAll();
      return { added, updated, skipped, flagged };
    }

    /* 本地图片上传到远端；成功后把名字从 localImages 移到 images（与原版 w() 一致） */
    async function uploadPendingImages(cfg) {
      const all = await db.diary.toArray();
      let uploaded = 0, failed = 0;
      for (const d of all) {
        const locals = splitSep(d.localImages);
        if (!locals.length) continue;
        const remaining = [];
        const images = splitSep(d.images);
        for (const name of locals) {
          let exists = false;
          try { exists = await window.fileApi.imageExists(name); } catch (e) { exists = false; }
          if (!exists) { remaining.push(name); continue; }
          try {
            const url = unwrap(await window.webdav.uploadImage(cfg, window.fileApi.getLocalImage(name)));
            if (url) { images.push(url); uploaded++; } else remaining.push(name);
          } catch (e) {
            remaining.push(name);
            failed++;
          }
        }
        // 一张都没传成功时不要碰 updateTime：合并规则是 updateTime 大者胜，
        // 白刷一次时间戳会让本地这份陈旧记录在下次同步时压过手机端的新编辑。
        if (remaining.length === locals.length) continue;
        await db.diary.update(d.id, {
          localImages: remaining.join(SEP),
          images: images.join(SEP),
          updateTime: Date.now(),
          synced: 1,
          isSynced: 1
        });
      }
      await countPendingImages();
      return { uploaded, failed };
    }

    async function countPendingImages() {
      const all = await db.diary.toArray();
      davPendingImages.value = all.reduce((n, d) => n + splitSep(d.localImages).length, 0);
      return davPendingImages.value;
    }

    async function davTest() {
      try {
        const r = unwrap(await window.webdav.check(davCfg()));
        toast(`连接成功，云端目录可用（HTTP ${r.status}）`, 'ok');
      } catch (e) {
        dav.value.lastError = String(e.message || e);
        davTouch();
        toast('连接失败：' + dav.value.lastError, 'err');
      }
    }

    function davTouch() {
      localStorage.setItem(DAV_KEY, JSON.stringify(Object.assign({}, dav.value)));
    }

    function davOk(msg) {
      dav.value.lastSync = new Date().toLocaleString();
      dav.value.lastError = '';
      davTouch();
      toast(msg, 'ok');
    }
    function davFail(prefix, e) {
      dav.value.lastError = String((e && e.message) || e);
      davTouch();
      toast(prefix + '：' + dav.value.lastError, 'err');
    }

    /* 覆盖远端之前先留一份底。
     * 同步是全量 PUT，没有增量：一旦本地数据有问题，这份快照是唯一能把
     * 手机端独有记录找回来的东西，所以拿不到快照就不许往远端写。
     * 返回 false 表示应当中止。
     */
    async function backupRemote(cfg) {
      try {
        const name = unwrap(await window.webdav.snapshotRemote(cfg));
        if (name) {
          dav.value.lastSnapshot = name;
          davTouch();
        }
        return true;
      } catch (e) {
        davFail('备份云端 diary.json 失败，已中止同步（未覆盖远端）', e);
        return false;
      }
    }

    async function syncDownloadOnly() {
      try {
        const cfg = davCfg();
        unwrap(await window.webdav.check(cfg));
        const obj = unwrap(await window.webdav.getDiaryJson(cfg));
        if (!obj) { toast('云端还没有 diary.json', 'err'); return; }
        const r = await mergeRemote(obj);
        davOk(
          `下载合并完成：日记 新增 ${r.added}、更新 ${r.updated}、跳过 ${r.skipped}` +
          `；分类/标签/模板 新增 ${r.flagged.added}、更新 ${r.flagged.updated}`
        );
      } catch (e) {
        davFail('下载失败', e);
      }
    }

    async function syncUploadOnly() {
      try {
        const cfg = davCfg();
        unwrap(await window.webdav.check(cfg));
        const img = await uploadPendingImages(cfg);
        if (!(await backupRemote(cfg))) return;
        const up = await buildUpload();
        unwrap(await window.webdav.putDiaryJson(cfg, up.payload));
        const t = Date.now();
        unwrap(await window.webdav.putSi(cfg, { t, d: SYNC_DATA_VERSION, dv: 'pc', id: localStorage.getItem('du') || '' }));
        localStorage.setItem('s_t', String(t));
        noteUploaded(up.stamp);
        await loadAll();
        davOk(`上传完成${img.uploaded ? '，含图片 ' + img.uploaded + ' 张' : ''}${img.failed ? '（' + img.failed + ' 张失败）' : ''}`);
      } catch (e) {
        davFail('上传失败', e);
      }
    }

    async function syncNow() {
      try {
        const cfg = davCfg();
        unwrap(await window.webdav.check(cfg));

        // 水位线要在上传之前读，而且只用来和"上次真正推上去的东西"比。
        // 判"无需同步"必须同时满足：云端 si.t 与本地一致、没有待传图片、本地也没有比
        // 上次上传更新的记录。少了最后一条，就会出现「自己上传完 -> 再改一篇 -> 同步」
        // 被判成"云端与本地一致，无需同步"，改动一直推不上去，只能等手机端先同步。
        const stamp = await localChangeStamp();
        const si = unwrap(await window.webdav.getSi(cfg));
        if (si && si.__undecodable) {
          toast('云端 si 无法解密，可能属于别的账号；已跳过判断，继续同步', 'err');
        } else if (si && Number(si.d) > SYNC_DATA_VERSION) {
          toast('云端数据版本比本程序新（d=' + si.d + '），请先更新本程序', 'err');
          return;
        } else if (si && String(si.t) === String(localStorage.getItem('s_t') || '')) {
          await countPendingImages();
          const lastUp = Number(dav.value.lastUploadTs);
          // 没有水位线（第一次同步 / 换了账号）一律当作有改动，宁可白推一次
          const localPending = !Number.isFinite(lastUp) || stamp > lastUp;
          // 我们这侧改了序列化格式（升级后第一次同步走到这里）也必须重推一次
          const formatStale = Number(dav.value.lastUploadFormat) !== REMOTE_FORMAT;
          if (!davPendingImages.value && !localPending && !formatStale) {
            davOk('云端与本地一致，无需同步');
            return;
          }
        }

        const obj = unwrap(await window.webdav.getDiaryJson(cfg));
        const merged = obj ? await mergeRemote(obj) : { added: 0, updated: 0, skipped: 0, flagged: { added: 0, updated: 0 } };

        const img = await uploadPendingImages(cfg);

        if (!(await backupRemote(cfg))) return;
        const up = await buildUpload();
        unwrap(await window.webdav.putDiaryJson(cfg, up.payload));

        const t = Date.now();
        unwrap(await window.webdav.putSi(cfg, { t, d: SYNC_DATA_VERSION, dv: 'pc', id: localStorage.getItem('du') || '' }));
        localStorage.setItem('s_t', String(t));
        noteUploaded(up.stamp);

        await loadAll();
        davOk(
          `同步完成：拉取日记 新增 ${merged.added}、更新 ${merged.updated}、跳过 ${merged.skipped}` +
          `；分类/标签/模板 新增 ${merged.flagged.added}、更新 ${merged.flagged.updated}` +
          `；上传图片 ${img.uploaded} 张`
        );
      } catch (e) {
        davFail('同步失败', e);
      }
    }

    /* ---------- 生命周期 ---------- */

    onMounted(async () => {
      dataPath.value = window.fileApi.getPath();
      loadDav();
      // 确认型弹窗没有输入框，没有元素能挂 esc，统一在窗口上收一次
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dialog.value) dialogCancel();
      });
      await openDb();
      await countPendingImages();
      // 诊断与自动化测试入口；也方便你自己在 DevTools 里手动跑同步
      window.__mydiary = {
        db,
        sync: {
          now: syncNow,
          upload: syncUploadOnly,
          download: syncDownloadOnly,
          test: davTest,
          payload: buildRemotePayload,
          merge: mergeRemote,
          cfg: davCfg,
          setCfg: (c) => { dav.value = Object.assign({}, dav.value, c); },
          state: () => JSON.parse(JSON.stringify(dav.value))
        },
        toast
      };
    });

    return {
      dbError, retryOpen: openDb,
      view, notice, search, dialog, dialogOk, dialogCancel,
      diaries, categories, tags,
      current, editing, editDate, editTags, editImages, preview, rendered,
      filterCategory, filterTag,
      filteredDiaries, listTitle,
      dataPath, filePicker, dav,
      calYear, calMonth, calendarCells, monthDiaries, dayFilter, dayDiaries,
      shiftMonth, selectDay,
      chartYear, chartMonth, chartCat,
      totalWords, writingDays, streak,
      plain, firstLine, splitTags, fmtDate, fmtTime, imgSrc,
      newDiary, openDiary, saveDiary, deleteDiary, togglePreview,
      pickImage, onFilePicked, onPaste, removeImage,
      addCategory, removeCategory, addTag, removeTag,
      exportBackup, importBackup, exportJson, importJson,
      davTest, davSave, davBase, davPendingImages, syncing,
      // 界面上的三个同步入口统一走 runSync：串行、防重叠；测试走 window.__mydiary.sync 里的原始函数
      syncNow: () => runSync(syncNow),
      syncUploadOnly: () => runSync(syncUploadOnly),
      syncDownloadOnly: () => runSync(syncDownloadOnly)
    };
  }
}).mount('#app');
