<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ApiError } from '../api/client';
import { booksApi } from '../api';
import { formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import { STATUS_LABELS, type Book, type BookStatus } from '../types/domain';

const books = ref<Book[]>([]);
const loading = ref(true);
const error = ref('');
const success = ref('');
const deletedBook = ref<{ id: string; title: string } | null>(null);
const search = ref('');
const status = ref<'ALL' | BookStatus>('ALL');
const page = ref(1);
const pageSize = 12;
const total = ref(0);

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  const params = new URLSearchParams({
    page: String(page.value),
    pageSize: String(pageSize)
  });
  if (search.value.trim()) params.set('search', search.value.trim());
  if (status.value !== 'ALL') params.set('status', status.value);
  try {
    const result = await booksApi.list(params);
    books.value = result.items;
    total.value = result.pagination.total;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '书目加载失败';
  } finally {
    loading.value = false;
  }
}

function submitSearch(): void {
  page.value = 1;
  void load();
}

function changePage(next: number): void {
  page.value = next;
  void load();
}

function clearDeletedBookState(): void {
  const state = { ...(window.history.state ?? {}) } as Record<string, unknown>;
  delete state.deletedBookId;
  delete state.deletedBookTitle;
  window.history.replaceState(state, '');
}

function dismissDeletedBook(): void {
  deletedBook.value = null;
  clearDeletedBookState();
}

async function restoreDeletedBook(): Promise<void> {
  if (!deletedBook.value) return;
  error.value = '';
  try {
    await booksApi.restore(deletedBook.value.id);
    success.value = `已恢复《${deletedBook.value.title}》及其全部阅读痕迹`;
    dismissDeletedBook();
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '恢复书目失败';
  }
}

onMounted(() => {
  const state = window.history.state as { deletedBookId?: unknown; deletedBookTitle?: unknown } | null;
  if (typeof state?.deletedBookId === 'string') {
    deletedBook.value = {
      id: state.deletedBookId,
      title: typeof state.deletedBookTitle === 'string' ? state.deletedBookTitle : ''
    };
  }
  void load();
});
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <p class="eyebrow">MY PAPER BOOKS</p>
        <h1>我的书</h1>
        <p>只记录书与你之间发生过什么。</p>
      </div>
      <RouterLink class="button button-primary" to="/books/new">添加书</RouterLink>
    </header>

    <form class="toolbar card" @submit.prevent="submitSearch">
      <label class="grow">
        搜索
        <input v-model="search" type="search" placeholder="书名或作者" />
      </label>
      <label>
        状态
        <select v-model="status" @change="submitSearch">
          <option value="ALL">全部</option>
          <option v-for="(label, value) in STATUS_LABELS" :key="value" :value="value">{{ label }}</option>
        </select>
      </label>
      <button class="button" type="submit">筛选</button>
    </form>

    <ErrorNotice :message="error" />

    <div v-if="deletedBook" class="success-notice" role="status">
      已删除《{{ deletedBook.title }}》，24 小时内可撤销。
      <button class="text-button" type="button" @click="restoreDeletedBook">撤销删除</button>
      <button class="text-button" type="button" @click="dismissDeletedBook">知道了</button>
    </div>
    <div v-else-if="success" class="success-notice" role="status">{{ success }}</div>

    <div v-if="loading" class="state-panel">正在翻阅你的书目…</div>
    <div v-else-if="books.length === 0" class="empty-state card">
      <span class="empty-mark">页</span>
      <h2>还没有记录一本纸质书</h2>
      <p>添加一本真实拥有的书，然后从某一页的折角或批注开始。</p>
      <RouterLink class="button button-primary" to="/books/new">添加第一本书</RouterLink>
    </div>
    <div v-else class="book-grid">
      <article v-for="book in books" :key="book.id" class="book-card card">
        <div class="book-card-top">
          <img
            v-if="book.coverUrl"
            class="book-cover"
            :src="book.coverUrl"
            :alt="`${book.title} 封面`"
            loading="lazy"
            referrerpolicy="no-referrer"
          />
          <div v-else class="book-cover book-cover-placeholder" aria-hidden="true">
            {{ book.title.slice(0, 1) }}
          </div>
          <div>
            <span class="status-badge" :data-status="book.status">{{ STATUS_LABELS[book.status] }}</span>
            <h2><RouterLink :to="`/books/${book.id}`">{{ book.title }}</RouterLink></h2>
            <p class="muted">{{ book.author || '作者未填写' }}</p>
          </div>
        </div>
        <p v-if="book.lastTraceAt" class="book-last-trace">
          最近留下痕迹：{{ formatDateTime(book.lastTraceAt) }}
        </p>
        <p v-else class="muted">还没有留下阅读痕迹</p>
        <dl class="trace-summary" aria-label="痕迹数量">
          <div><dt>折角</dt><dd>{{ book.traceSummary.dogEars }}</dd></div>
          <div><dt>批注</dt><dd>{{ book.traceSummary.annotations }}</dd></div>
          <div><dt>重读页</dt><dd>{{ book.traceSummary.rereadMarks }}</dd></div>
        </dl>
        <p v-if="book.hasCompletionReflection" class="completion-hint">
          已留下读完后的感受
        </p>
        <RouterLink class="button button-block" :to="`/books/${book.id}`">查看这本书</RouterLink>
      </article>
    </div>

    <nav v-if="total > pageSize" class="pagination" aria-label="书目分页">
      <button class="button button-quiet" :disabled="page <= 1" @click="changePage(page - 1)">上一页</button>
      <span>第 {{ page }} 页，共 {{ Math.ceil(total / pageSize) }} 页</span>
      <button class="button button-quiet" :disabled="page >= Math.ceil(total / pageSize)" @click="changePage(page + 1)">
        下一页
      </button>
    </nav>
  </section>
</template>
