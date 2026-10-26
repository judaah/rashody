import { db } from '../db/db';
import { allCategories, setSetting, SETTING_LAST_BACKUP } from '../db/repo';
import { backupFileName, expensesToCsv, exportBackup } from '../lib/backup';
import { today } from '../lib/dates';
import { showToast } from './toast';

// На телефоне отдаём файл через «Поделиться» (там есть «Сохранить в Файлы»),
// на компьютере — обычным скачиванием.
const isTouchDevice = () => window.matchMedia('(pointer: coarse)').matches;

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Отдаёт файл пользователю. onSaved вызывается, когда файл точно отдан
 * (скачан или выбран пункт в меню «Поделиться»), а не при отмене.
 */
async function deliver(file: File, onSaved: () => void | Promise<void>): Promise<void> {
  if (!isTouchDevice() || !navigator.canShare?.({ files: [file] })) {
    download(file);
    await onSaved();
    return;
  }
  try {
    await navigator.share({ files: [file] });
    await onSaved();
  } catch (err) {
    const name = (err as DOMException).name;
    if (name === 'AbortError') return; // закрыл меню «Поделиться»
    if (name === 'NotAllowedError') {
      // Safari не дал открыть меню после долгой подготовки файла — просим ещё одно нажатие.
      showToast('Файл готов', { action: 'Сохранить', onAction: () => void deliver(file, onSaved) });
      return;
    }
    throw err;
  }
}

export async function saveBackupFile(): Promise<void> {
  const backup = await exportBackup();
  const file = new File([JSON.stringify(backup)], backupFileName(), { type: 'application/json' });
  await deliver(file, async () => {
    await setSetting(SETTING_LAST_BACKUP, Date.now());
    showToast('Бэкап сохранён');
  });
}

export async function saveCsvFile(): Promise<void> {
  const [expenses, categories] = await Promise.all([db.expenses.toArray(), allCategories()]);
  const file = new File([expensesToCsv(expenses, categories)], `rashody-${today()}.csv`, { type: 'text/csv' });
  await deliver(file, () => showToast(`Выгружено трат: ${expenses.length}`));
}
