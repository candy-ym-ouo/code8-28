<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { booksApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import { STATUS_LABELS, type DeletedBook } from '../types/domain';

const books = ref<DeletedBook[]>([]);
const loading = ref(true);
const restoringId = ref<string | null>(null);
const error = ref('');
const notice = ref('');

const now = ref(Date.now());

const restorableBooks = computed(() =>
  books.value.filter((book) => new Date(book.restorableUntil).getTime() > now.value)
);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const result = await booksApi.deleted();
    books.value = result.items;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '回收站加载失败';
  } finally {
    loading.value = false;
  }
}

async function restoreBook(book: DeletedBook): Promise<void> {
  if (!window.confirm(`整书恢复《${book.title}》？随书删除的折角、批注、重读页和读完感受会一并找回。`)) return;
  restoringId.value = book.id;
  error.value = '';
  try {
    await booksApi.restore(book.id);
    notice.value = `《${book.title}》及其完整影响链已恢复`;
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '恢复失败';
  } finally {
    restoringId.value = null;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">TRASH</p>
        <h1>回收站</h1>
        <p>这里是近 24 小时内删除的书。整书恢复会一起找回当时随书收起的痕迹、感受与时间线。</p>
      </div>
      <RouterLink class="button button-quiet" to="/">返回我的书</RouterLink>
    </header>

    <ErrorNotice :message="error" />
    <div v-if="notice" class="success-notice" role="status">{{ notice }}</div>

    <div v-if="loading" class="state-panel">正在翻找被收起的书…</div>
    <div v-else-if="restorableBooks.length === 0" class="empty-state card">
      <span class="empty-mark">空</span>
      <h2>回收站是空的</h2>
      <p>24 小时内删除的书才会出现在这里，恢复窗口过后数据仍会保留在你的档案导出中。</p>
      <RouterLink class="button button-primary" to="/">返回我的书</RouterLink>
    </div>
    <div v-else class="book-grid">
      <article v-for="book in restorableBooks" :key="book.id" class="book-card card">
        <div class="book-card-top">
          <div class="book-cover book-cover-placeholder" aria-hidden="true">{{ book.title.slice(0, 1) }}</div>
          <div>
            <span class="status-badge" :data-status="book.status">{{ STATUS_LABELS[book.status] }}</span>
            <h2>{{ book.title }}</h2>
            <p class="muted">{{ book.author || '作者未填写' }}</p>
          </div>
        </div>
        <p class="book-last-trace">删除于 {{ formatDateTime(book.deletedAt) }}</p>
        <p class="muted">可恢复至 {{ formatDateTime(book.restorableUntil) }}</p>
        <div class="button-row">
          <button class="button button-primary button-block" type="button" :disabled="restoringId === book.id" @click="restoreBook(book)">
            {{ restoringId === book.id ? '正在恢复…' : '整书恢复' }}
          </button>
        </div>
      </article>
    </div>
  </section>
</template>
