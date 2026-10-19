// sync-shift アプリケーションコアロジック

const START_HOUR = 7;
const END_HOUR = 24; // 7:00 〜 24:00 (17時間)
const SLOT_MINUTES = 30; // 30分単位
const SLOTS_PER_HOUR = 60 / SLOT_MINUTES;
const TOTAL_SLOTS = (END_HOUR - START_HOUR) * SLOTS_PER_HOUR;
const CELL_HEIGHT = 44; // px

let currentWeekOffset = 0; // 0 = 今週
let isDragging = false;
let dragStart = null; // { dayIndex, slotIndex }
let dragCurrent = null; // { dayIndex, slotIndex }
let currentSelection = null; // { dayIndex, startSlot, endSlot }

// サンプル登録済みイベントストア
const registeredEvents = [
  {
    id: 'mock-1',
    title: 'シフト勤務 (レジ・品出し)',
    dateStr: '2026-10-20',
    startHour: 9,
    startMin: 0,
    endHour: 15,
    endMin: 0,
    category: 'work'
  },
  {
    id: 'mock-2',
    title: '個人開発・ミーティング',
    dateStr: '2026-10-21',
    startHour: 18,
    startMin: 0,
    endHour: 21,
    endMin: 0,
    category: 'business'
  }
];

// DOM要素
const gridHeader = document.getElementById('gridHeader');
const gridBody = document.getElementById('gridBody');
const timeLabels = document.getElementById('timeLabels');
const weekRangeLabel = document.getElementById('weekRangeLabel');
const prevWeekBtn = document.getElementById('prevWeekBtn');
const nextWeekBtn = document.getElementById('nextWeekBtn');
const calendarSelect = document.getElementById('calendarSelect');
const submitBtn = document.getElementById('submitBtn');
const clearBtn = document.getElementById('clearBtn');
const selectionInfo = document.getElementById('selectionInfo');
const toast = document.getElementById('toast');

// 日付計算ヘルパー
function getWeekDates(offsetWeeks = 0) {
  const now = new Date();
  const currentDay = now.getDay(); // 0: 日, 1: 月, ...
  const mondayOffset = (currentDay === 0 ? -6 : 1) - currentDay; // 月曜基準
  
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset + (offsetWeeks * 7));
  monday.setHours(0,0,0,0);

  const weekDates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    weekDates.push(d);
  }
  return weekDates;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatTime(slotIndex) {
  const totalMinutes = (START_HOUR * 60) + (slotIndex * SLOT_MINUTES);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 初期化描画
function initTimeLabels() {
  timeLabels.innerHTML = '';
  for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
    const slotEl = document.createElement('div');
    slotEl.className = 'time-slot-label';
    if (slot % SLOTS_PER_HOUR === 0) {
      const hour = START_HOUR + Math.floor(slot / SLOTS_PER_HOUR);
      slotEl.textContent = `${hour}:00`;
    }
    timeLabels.appendChild(slotEl);
  }
}

function renderWeek() {
  const weekDates = getWeekDates(currentWeekOffset);
  const dayNames = ['月', '火', '水', '木', '金', '土', '日'];
  const today = new Date();
  const todayStr = formatDate(today);

  // ヘッダーラベル更新
  const startStr = `${weekDates[0].getMonth() + 1}/${weekDates[0].getDate()}`;
  const endStr = `${weekDates[6].getMonth() + 1}/${weekDates[6].getDate()}`;
  weekRangeLabel.textContent = `${weekDates[0].getFullYear()}/${startStr} - ${endStr}`;

  // 曜日ヘッダー描画
  while (gridHeader.children.length > 1) {
    gridHeader.removeChild(gridHeader.lastChild);
  }

  weekDates.forEach((date, i) => {
    const dStr = formatDate(date);
    const cell = document.createElement('div');
    cell.className = 'header-cell';
    if (dStr === todayStr) cell.classList.add('is-today');
    if (i === 5) cell.classList.add('is-sat');
    if (i === 6) cell.classList.add('is-sun');

    cell.innerHTML = `
      <div class="day-name">${dayNames[i]}</div>
      <div class="day-number">${date.getDate()}</div>
    `;
    gridHeader.appendChild(cell);
  });

  // グリッド列描画
  const existingCols = gridBody.querySelectorAll('.day-column');
  existingCols.forEach(c => c.remove());

  weekDates.forEach((date, dayIdx) => {
    const dateStr = formatDate(date);
    const col = document.createElement('div');
    col.className = 'day-column';
    col.dataset.dayIndex = dayIdx;
    col.dataset.dateStr = dateStr;

    for (let slot = 0; slot < TOTAL_SLOTS; slot++) {
      const slotCell = document.createElement('div');
      slotCell.className = 'slot-cell';
      slotCell.dataset.slotIndex = slot;
      col.appendChild(slotCell);
    }

    // 登録済みイベントを配置
    renderCommittedEventsForDay(col, dateStr);

    gridBody.appendChild(col);
  });

  clearSelection();
}

// 確定済みイベントの描画
function renderCommittedEventsForDay(colEl, dateStr) {
  const events = registeredEvents.filter(e => e.dateStr === dateStr);
  events.forEach(evt => {
    const startMinutes = (evt.startHour * 60 + evt.startMin) - (START_HOUR * 60);
    const endMinutes = (evt.endHour * 60 + evt.endMin) - (START_HOUR * 60);

    if (startMinutes < 0 || endMinutes <= startMinutes) return;

    const startSlots = startMinutes / SLOT_MINUTES;
    const durationSlots = (endMinutes - startMinutes) / SLOT_MINUTES;

    const topPx = startSlots * CELL_HEIGHT;
    const heightPx = Math.max(durationSlots * CELL_HEIGHT - 2, 24);

    const block = document.createElement('div');
    block.className = `committed-block ${evt.category}`;
    block.style.top = `${topPx}px`;
    block.style.height = `${heightPx}px`;
    block.innerHTML = `
      <div style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${evt.title}</div>
      <div style="font-size:0.68rem;">${formatTime(startSlots)} - ${formatTime(startSlots + durationSlots)}</div>
      <button class="del-btn" title="削除" onclick="deleteEvent('${evt.id}', event)">×</button>
    `;
    colEl.appendChild(block);
  });
}

// イベント削除
window.deleteEvent = function(id, e) {
  e.stopPropagation();
  const idx = registeredEvents.findIndex(item => item.id === id);
  if (idx !== -1) {
    registeredEvents.splice(idx, 1);
    renderWeek();
    showToast('予定を解除しました');
  }
};

// ドラッグ選択関連
function getSlotAndDayFromPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;

  const slotCell = el.closest('.slot-cell');
  if (slotCell) {
    const col = slotCell.closest('.day-column');
    if (col) {
      return {
        dayIndex: parseInt(col.dataset.dayIndex, 10),
        dateStr: col.dataset.dateStr,
        slotIndex: parseInt(slotCell.dataset.slotIndex, 10),
        colEl: col
      };
    }
  }
  return null;
}

function updateSelectionOverlay() {
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();

  if (!currentSelection) {
    submitBtn.disabled = true;
    selectionInfo.innerHTML = '未選択 (画面をなぞって時間帯を指定)';
    return;
  }

  const { dayIndex, startSlot, endSlot, dateStr } = currentSelection;
  const targetCol = gridBody.querySelector(`.day-column[data-day-index="${dayIndex}"]`);
  if (!targetCol) return;

  const topPx = startSlot * CELL_HEIGHT;
  const heightPx = (endSlot - startSlot + 1) * CELL_HEIGHT;

  const startTimeStr = formatTime(startSlot);
  const endTimeStr = formatTime(endSlot + 1);

  const overlay = document.createElement('div');
  overlay.className = 'selection-overlay';
  overlay.style.top = `${topPx}px`;
  overlay.style.height = `${heightPx}px`;
  overlay.style.left = '3px';
  overlay.style.right = '3px';

  const calType = calendarSelect.options[calendarSelect.selectedIndex].text;

  overlay.innerHTML = `
    <div class="sel-title">選択中: ${calType}</div>
    <div class="sel-time">${startTimeStr} 〜 ${endTimeStr}</div>
  `;

  targetCol.appendChild(overlay);

  submitBtn.disabled = false;
  selectionInfo.innerHTML = `<span>${dateStr}</span> <span>${startTimeStr} - ${endTimeStr}</span> を選択中`;
}

function clearSelection() {
  currentSelection = null;
  dragStart = null;
  dragCurrent = null;
  isDragging = false;
  const oldOverlay = document.querySelector('.selection-overlay');
  if (oldOverlay) oldOverlay.remove();
  submitBtn.disabled = true;
  selectionInfo.innerHTML = '未選択 (画面をなぞって時間帯を指定)';
}

// マウス / タッチ共通イベントハンドラ
function handlePointerDown(e) {
  if (e.target.closest('.del-btn') || e.target.closest('.committed-block')) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const point = getSlotAndDayFromPoint(clientX, clientY);

  if (point) {
    isDragging = true;
    dragStart = point;
    dragCurrent = point;
    calculateSelection();
  }
}

function handlePointerMove(e) {
  if (!isDragging || !dragStart) return;

  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const point = getSlotAndDayFromPoint(clientX, clientY);

  if (point && point.dayIndex === dragStart.dayIndex) {
    dragCurrent = point;
    calculateSelection();
  }
}

function handlePointerUp() {
  if (isDragging) {
    isDragging = false;
  }
}

function calculateSelection() {
  if (!dragStart || !dragCurrent) return;

  const minSlot = Math.min(dragStart.slotIndex, dragCurrent.slotIndex);
  const maxSlot = Math.max(dragStart.slotIndex, dragCurrent.slotIndex);

  currentSelection = {
    dayIndex: dragStart.dayIndex,
    dateStr: dragStart.dateStr,
    startSlot: minSlot,
    endSlot: maxSlot
  };

  updateSelectionOverlay();
}

// トースト表示
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// 登録ボタン押下
submitBtn.addEventListener('click', () => {
  if (!currentSelection) return;

  const calValue = calendarSelect.value;
  const calName = calendarSelect.options[calendarSelect.selectedIndex].text;
  const startTimeStr = formatTime(currentSelection.startSlot);
  const endTimeStr = formatTime(currentSelection.endSlot + 1);

  const [sH, sM] = startTimeStr.split(':').map(Number);
  const [eH, eM] = endTimeStr.split(':').map(Number);

  const newEvent = {
    id: 'evt-' + Date.now(),
    title: `${calName.split(' ')[0]} 予定`,
    dateStr: currentSelection.dateStr,
    startHour: sH,
    startMin: sM,
    endHour: eH,
    endMin: eM,
    category: calValue
  };

  registeredEvents.push(newEvent);
  showToast(`⚡ ${currentSelection.dateStr} [${startTimeStr}-${endTimeStr}] を ${calName} に一括登録完了！`);
  renderWeek();
});

clearBtn.addEventListener('click', clearSelection);

// 週移動
prevWeekBtn.addEventListener('click', () => {
  currentWeekOffset--;
  renderWeek();
});

nextWeekBtn.addEventListener('click', () => {
  currentWeekOffset++;
  renderWeek();
});

// タッチイベント
gridBody.addEventListener('touchstart', handlePointerDown, { passive: false });
gridBody.addEventListener('touchmove', handlePointerMove, { passive: false });
window.addEventListener('touchend', handlePointerUp);

// マウスイベント
gridBody.addEventListener('mousedown', handlePointerDown);
window.addEventListener('mousemove', handlePointerMove);
window.addEventListener('mouseup', handlePointerUp);

calendarSelect.addEventListener('change', () => {
  if (currentSelection) updateSelectionOverlay();
});

// 初期化
initTimeLabels();
renderWeek();
