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

const db = new Dexie('diary');

// ↓↓↓ 以下三段必须与官方数据格式完全一致，不要重排或增删字段 ↓↓↓
db.version(1).stores({
  diary:
    '++id, title, content, createTime, updateTime, recordTime, images, localImages, city, address, temperature, weather, color, dayOfMonth, monthOfYear, year, latitude, longitude, deleted, uuid, synced, isHidden, device, category, type, audio, localAudio, contentType, tag, historyTime, draw, localDraw, top, bt, m, ind',
  category: '++id, name, count, pic, isDeleted, uuid, recordModelId, createTime, updateTime, synced',
  recordModel:
    '++id, content, position, order, title, contentType, name, uuid, isDelete, isDefault, createTime, updateTime, synced',
  tag: '++id, name, deleted, uuid, order, lock, createTime, updateTime, synced'
});
db.version(2).stores({ history: '++id, content, uuid, createTime' });
db.version(3).stores({ draft: '++id, title, content, uuid, createTime, shown' });
// ↑↑↑ 到此为止 ↑↑↑

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
      syncType: 2,
      customUrl: '',
      username: '',
      password: '',
      selfSigned: false,
      lastSync: '',
      lastError: ''
    });
    const davPendingImages = ref(0);

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

    function newDiary() {
      editing.value = blankDiary();
      editDate.value = tsToDateInput(editing.value.recordTime);
      editTags.value = '';
      editImages.value = [];
      preview.value = false;
      current.value = null;
      view.value = 'list';
    }

    function openDiary(d) {
      current.value = d;
      editing.value = Object.assign({}, d);
      editDate.value = tsToDateInput(d.recordTime || d.createTime);
      editTags.value = splitSep(d.tag).join(', ');
      editImages.value = splitSep(d.localImages);
      preview.value = false;
      view.value = 'list';
    }

    function togglePreview() {
      preview.value = !preview.value;
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
        }
        toast('已保存', 'ok');
      } catch (err) {
        toast('保存失败：' + ((err && err.message) || err), 'err');
      }
    }

    async function deleteDiary() {
      if (!current.value || current.value.id == null) {
        newDiary();
        return;
      }
      if (!(await askConfirm('删除这篇日记？', '此操作不可撤销。', '删除'))) return;
      try {
        await db.diary.delete(current.value.id);
        current.value = null;
        editing.value = null;
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

    async function onFilePicked(ev) {
      const files = Array.from(ev.target.files || []);
      for (const f of files) {
        let name = '';
        if (f.path) {
          name = await window.fileApi.saveImage(f.path);
        } else {
          const buf = await f.arrayBuffer();
          name = await window.fileApi.saveImageBuffer(Array.from(new Uint8Array(buf)), '.' + (f.name.split('.').pop() || 'jpeg'));
        }
        if (name) editImages.value.push(name);
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
          const buf = await file.arrayBuffer();
          const ext = '.' + (it.type.split('/')[1] || 'jpeg').replace('jpeg', 'jpeg');
          const name = await window.fileApi.saveImageBuffer(Array.from(new Uint8Array(buf)), ext);
          if (name) editImages.value.push(name);
        }
      }
    }

    function removeImage(name) {
      editImages.value = editImages.value.filter((x) => x !== name);
    }

    /* ---------- 分类 / 标签 ---------- */

    async function refreshCategoryCounts() {
      const all = await db.diary.toArray();
      const counter = {};
      all.forEach((d) => {
        if (d.category) counter[d.category] = (counter[d.category] || 0) + 1;
      });
      const cats = await db.category.toArray();
      for (const c of cats) {
        const n = counter[c.name] || 0;
        if ((c.count || 0) !== n) await db.category.update(c.id, { count: n });
      }
    }

    async function addCategory() {
      const name = await askText('新建分类', '', '例如：工作 / 生活 / 学习');
      if (!name || !name.trim()) return;
      const n = name.trim();
      if (categories.value.some((c) => c.name === n)) {
        toast('分类已存在', 'err');
        return;
      }
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
      await loadAll();
    }

    async function removeCategory(c) {
      if (!(await askConfirm(`删除分类「${c.name}」？`, '日记本身不会被删除，只是取消归类。', '删除'))) return;
      await db.category.update(c.id, { isDeleted: 1, updateTime: Date.now(), synced: 1 });
      const affected = diaries.value.filter((d) => d.category === c.name);
      for (const d of affected) await db.diary.update(d.id, { category: '', updateTime: Date.now(), synced: 1 });
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
      const name = currentUserId() + (localStorage.getItem('sync_type') || 1);
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

      const existing = await db.diary.toArray();
      const byUuid = {};
      existing.forEach((d) => { if (d.uuid) byUuid[d.uuid] = d; });

      let added = 0, updated = 0;
      for (const rec of list) {
        const r = Object.assign({}, rec);
        delete r.id;
        r.synced = 1;
        const old = r.uuid ? byUuid[r.uuid] : null;
        if (old) {
          if ((r.updateTime || 0) > (old.updateTime || 0)) {
            await db.diary.update(old.id, r);
            updated++;
          }
        } else {
          await db.diary.add(r);
          added++;
        }
      }

      const existCats = await db.category.toArray();
      const catNames = new Set(existCats.map((c) => c.name));
      for (const c of cats) {
        if (catNames.has(c.name)) continue;
        const r = Object.assign({}, c);
        delete r.id;
        r.synced = 1;
        await db.category.add(r);
      }

      const existTags = await db.tag.toArray();
      const tagNames = new Set(existTags.map((t) => t.name));
      for (const t of tgs) {
        if (tagNames.has(t.name)) continue;
        const r = Object.assign({}, t);
        delete r.id;
        r.synced = 1;
        await db.tag.add(r);
      }

      await refreshCategoryCounts();
      await loadAll();
      toast(`导入完成：新增 ${added}、更新 ${updated}`, 'ok');
    }

    /* ---------- WebDAV：原版《一本日记》第三方同步协议 ---------- */

    const DAV_KEY = 'mydiary_webdav';
    const SYNC_DATA_VERSION = 1;

    function loadDav() {
      try {
        const raw = localStorage.getItem(DAV_KEY);
        if (raw) { dav.value = Object.assign(dav.value, JSON.parse(raw)); return; }
      } catch (e) { /* 忽略损坏的配置 */ }

      // 首次使用：原版 PC 端如果已经配过第三方同步，直接沿用它的账号，省得重输。
      // localStorage 是与原版共用的，sync_type / wd_url / auth 就是原版存的位置。
      try {
        const st = Number(localStorage.getItem('sync_type') || 0);
        if (st === 2 || st === 4) {
          dav.value.syncType = st;
          if (st === 4) dav.value.customUrl = localStorage.getItem('wd_url') || '';
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
    function davSave() {
      const cfg = Object.assign({}, dav.value);
      delete cfg.lastSync;
      delete cfg.lastError;
      localStorage.setItem(DAV_KEY, JSON.stringify(cfg));
      toast('WebDAV 配置已保存', 'ok');
    }
    function davCfg() {
      return {
        syncType: dav.value.syncType,
        customUrl: dav.value.customUrl,
        username: dav.value.username,
        password: dav.value.password,
        selfSigned: !!dav.value.selfSigned
      };
    }
    const davBase = computed(() => {
      if (Number(dav.value.syncType) === 2) return 'https://dav.jianguoyun.com/dav';
      if (Number(dav.value.syncType) === 3) return 'https://dav.box.com/dav';
      return String(dav.value.customUrl || '').replace(/\/+$/, '');
    });
    function unwrap(res) {
      if (!res) throw new Error('无响应');
      if (!res.ok) throw new Error(res.error || '未知错误');
      return res.data;
    }

    /* --- 本地 -> 远端：布尔化，并把 category 挪到 type（与原版 b() 一致，只改副本） --- */
    function toRemoteDiary(d) {
      const o = Object.assign({}, d);
      delete o.id;
      o.deleted = o.deleted == 1;
      o.isHidden = o.isHidden == 1;
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

    async function buildRemotePayload() {
      const diaries = await db.diary.toArray();
      const cats = await db.category.toArray();
      const models = await db.recordModel.toArray();
      const tags = await db.tag.toArray();
      return {
        // 注意：该键名固定为 "catagory"（就是这个拼写），不能写成 category
        json: JSON.stringify(diaries.map(toRemoteDiary)),
        catagory: JSON.stringify(cats.map(toRemoteCategory)),
        model: JSON.stringify(models.map(toRemoteModel)),
        tag: JSON.stringify(tags.map(toRemoteTag))
      };
    }

    async function mergeRemote(obj) {
      let added = 0, updated = 0, skipped = 0;

      let list = [];
      try { list = obj && obj.json ? JSON.parse(obj.json) : []; } catch (e) { list = []; }
      for (const a of list) {
        const local = a.uuid ? await db.diary.where('uuid').equals(a.uuid).first() : null;
        if (local) {
          if ((local.updateTime || 0) < (a.updateTime || 0)) {
            await db.diary.update(local.id, fromRemoteDiary(a));
            updated++;
          } else if ((local.updateTime || 0) === (a.updateTime || 0) && local.synced === 0) {
            await db.diary.update(local.id, { synced: 1 });
          }
        } else {
          if (a.deleted && !(a.historyTime || 0)) { skipped++; continue; }
          await db.diary.add(fromRemoteDiary(a));
          added++;
        }
      }

      let cats = [];
      try { cats = obj && obj.catagory ? JSON.parse(obj.catagory) : []; } catch (e) { cats = []; }
      for (const a of cats) {
        const local = a.uuid ? await db.category.where('uuid').equals(a.uuid).first() : null;
        if (local) {
          if ((local.updateTime || 0) < (a.updateTime || 0)) await db.category.update(local.id, fromRemoteFlag(a, 'isDeleted'));
        } else {
          if (a.isDeleted) continue;
          await db.category.add(fromRemoteFlag(a, 'isDeleted'));
        }
      }

      let tags = [];
      try { tags = obj && obj.tag ? JSON.parse(obj.tag) : []; } catch (e) { tags = []; }
      for (const a of tags) {
        const local = a.uuid ? await db.tag.where('uuid').equals(a.uuid).first() : null;
        if (local) {
          if ((local.updateTime || 0) < (a.updateTime || 0)) await db.tag.update(local.id, fromRemoteFlag(a, 'deleted'));
        } else {
          if (a.deleted) continue;
          await db.tag.add(fromRemoteFlag(a, 'deleted'));
        }
      }

      let models = [];
      try { models = obj && obj.model ? JSON.parse(obj.model) : []; } catch (e) { models = []; }
      for (const a of models) {
        const local = a.uuid ? await db.recordModel.where('uuid').equals(a.uuid).first() : null;
        if (local) {
          if ((local.updateTime || 0) < (a.updateTime || 0)) await db.recordModel.update(local.id, fromRemoteFlag(a, 'isDelete'));
        } else {
          if (a.isDelete) continue;
          await db.recordModel.add(fromRemoteFlag(a, 'isDelete'));
        }
      }

      await loadAll();
      return { added, updated, skipped };
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
        await db.diary.update(d.id, {
          localImages: remaining.join('|'),
          images: images.join('|'),
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

    async function syncDownloadOnly() {
      try {
        const cfg = davCfg();
        unwrap(await window.webdav.check(cfg));
        const obj = unwrap(await window.webdav.getDiaryJson(cfg));
        if (!obj) { toast('云端还没有 diary.json', 'err'); return; }
        const r = await mergeRemote(obj);
        davOk(`下载合并完成：新增 ${r.added}、更新 ${r.updated}、跳过 ${r.skipped}`);
      } catch (e) {
        davFail('下载失败', e);
      }
    }

    async function syncUploadOnly() {
      try {
        const cfg = davCfg();
        unwrap(await window.webdav.check(cfg));
        const img = await uploadPendingImages(cfg);
        unwrap(await window.webdav.putDiaryJson(cfg, await buildRemotePayload()));
        const t = Date.now();
        unwrap(await window.webdav.putSi(cfg, { t, d: SYNC_DATA_VERSION, dv: 'pc', id: localStorage.getItem('du') || '' }));
        localStorage.setItem('s_t', String(t));
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

        const si = unwrap(await window.webdav.getSi(cfg));
        if (si && si.__undecodable) {
          toast('云端 si 无法解密，可能属于别的账号；已跳过判断，继续同步', 'err');
        } else if (si && Number(si.d) > SYNC_DATA_VERSION) {
          toast('云端数据版本比本程序新（d=' + si.d + '），请先更新本程序', 'err');
          return;
        } else if (si && String(si.t) === String(localStorage.getItem('s_t') || '')) {
          await countPendingImages();
          if (!davPendingImages.value) {
            davOk('云端与本地一致，无需同步');
            return;
          }
        }

        const obj = unwrap(await window.webdav.getDiaryJson(cfg));
        const merged = obj ? await mergeRemote(obj) : { added: 0, updated: 0, skipped: 0 };

        const img = await uploadPendingImages(cfg);

        unwrap(await window.webdav.putDiaryJson(cfg, await buildRemotePayload()));

        const t = Date.now();
        unwrap(await window.webdav.putSi(cfg, { t, d: SYNC_DATA_VERSION, dv: 'pc', id: localStorage.getItem('du') || '' }));
        localStorage.setItem('s_t', String(t));

        await loadAll();
        davOk(`同步完成：拉取新增 ${merged.added}、更新 ${merged.updated}；上传图片 ${img.uploaded} 张`);
      } catch (e) {
        davFail('同步失败', e);
      }
    }

    /* ---------- 生命周期 ---------- */

    onMounted(async () => {
      dataPath.value = window.fileApi.getPath();
      loadDav();
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
      davTest, davSave, syncNow, syncUploadOnly, syncDownloadOnly, davBase, davPendingImages
    };
  }
}).mount('#app');
