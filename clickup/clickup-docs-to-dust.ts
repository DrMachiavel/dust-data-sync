import axios, { AxiosResponse } from 'axios';
import * as dotenv from 'dotenv';
import Bottleneck from 'bottleneck';
import slugify from 'slugify';

dotenv.config();

// source
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const CLICKUP_WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID;
const CLICKUP_DOC_ID = process.env.CLICKUP_DOC_ID;

// destination
const DUST_API_KEY = process.env.DUST_API_KEY;
const DUST_WORKSPACE_ID = process.env.DUST_WORKSPACE_ID;
const DUST_DATASOURCE_ID = process.env.DUST_DATASOURCE_ID;
const DUST_VAULT_ID = process.env.DUST_VAULT_ID;

console.log('[Environment Variables]: Loaded');

const missingEnvVars = [
  ['CLICKUP_API_KEY', CLICKUP_API_KEY],
  ['CLICKUP_WORKSPACE_ID', CLICKUP_WORKSPACE_ID],
  ['CLICKUP_DOC_ID', CLICKUP_DOC_ID],
  ['DUST_API_KEY', DUST_API_KEY],
  ['DUST_WORKSPACE_ID', DUST_WORKSPACE_ID],
  ['DUST_DATASOURCE_ID', DUST_DATASOURCE_ID],
  ['DUST_VAULT_ID', DUST_VAULT_ID]
].filter(([name, value]) => !value).map(([name]) => name);

if (missingEnvVars.length > 0) {
  console.error(`[Error]: Missing environment variables: ${missingEnvVars.join(', ')}`);
  throw new Error(`Please provide values for the following environment variables in the .env file: ${missingEnvVars.join(', ')}`);
}

const clickupApi = axios.create({
  baseURL: 'https://api.clickup.com/api/v3',
  headers: {
    'Authorization': CLICKUP_API_KEY,
    'Content-Type': 'application/json'
  },
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
  timeout: 30000, // 30 second timeout
  timeoutErrorMessage: 'Request timed out'
});

// Add rate limiting for ClickUp API
const clickupLimiter = new Bottleneck({
  minTime: 1000, // 1 second between requests
  maxConcurrent: 1
});

// Wrap getClickUpPages with retry logic and rate limiting
const getClickUpPagesWithRetry = clickupLimiter.wrap(async (docId: string): Promise<ClickUpPage[]> => {
  console.log(`[getClickUpPagesWithRetry] Starting to fetch pages for docId: ${docId}`);
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[getClickUpPagesWithRetry] Attempt ${attempt}/${maxRetries}`);
    try {
      console.log(`[getClickUpPagesWithRetry] Making API request to ClickUp`);
      const response: AxiosResponse<ClickUpPage[]> = await clickupApi.get(
        `/workspaces/${CLICKUP_WORKSPACE_ID}/docs/${docId}/pages`,
        {
          params: {
            max_page_depth: 1,
            content_format: 'text/md'
          }
        }
      );
      console.log(`[getClickUpPagesWithRetry] Retrieved ${response.data.length} pages from ClickUp`);
      return response.data;
    } catch (error) {
      lastError = error;
      console.error(`[getClickUpPagesWithRetry] Attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        console.log(`[getClickUpPagesWithRetry] Retrying in ${2000 * attempt}ms`);
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // Exponential backoff
      }
    }
  }
  console.error(`[getClickUpPagesWithRetry] All retries failed:`, lastError);
  throw lastError;
});

clickupApi.interceptors.response.use(
  (response) => {
    console.log(`[ClickUp API Interceptor]: Endpoint: ${response.config.url}, Status: ${response.status}`);
    return response;
  },
  (error) => {
    console.error(`[ClickUp API Interceptor]: Error:`, error);
    if (error.response && error.response.status === 429) {
      console.error(`[ClickUp API Interceptor]: Endpoint: ${error.config.url}, Rate limit exceeded. Please wait before making more requests.`);
    }
    return Promise.reject(error);
  }
);

// Create a Bottleneck limiter for Dust API
const dustLimiter = new Bottleneck({
  minTime: 500, // 500ms between requests
  maxConcurrent: 1, // Only 1 request at a time
});

const dustApi = axios.create({
  baseURL: 'https://dust.tt/api/v1',
  headers: {
    'Authorization': `Bearer ${DUST_API_KEY}`,
    'Content-Type': 'application/json'
  },
  maxContentLength: Infinity,
  maxBodyLength: Infinity
});

// Wrap dustApi.post with the limiter
const limitedDustApiPost = dustLimiter.wrap(
  (url: string, data: any, config?: any) => dustApi.post(url, data, config)
);

interface ClickUpPage {
  workspace_id: string;
  doc_id: string;
  id: string;
  archived: boolean;
  name: string;
  content: string;
  parent_id: string | null;
  pages: ClickUpPage[];
  date_created: number;
  date_updated: number;
}

function generateSlug(name: string): string {
  console.log(`[generateSlug] Generating slug for: ${name}`);
  const slug = slugify(name, {
    lower: true,
    strict: true,
    trim: true
  });
  console.log(`[generateSlug] Generated slug: ${slug}`);
  return slug;
}

async function getClickUpPages(docId: string): Promise<ClickUpPage[]> {
  console.log(`[getClickUpPages] Fetching pages for docId: ${docId}`);
  try {
    const pages = await getClickUpPagesWithRetry(docId);
    console.log(`[getClickUpPages] Retrieved ${pages.length} pages`);
    return pages;
  } catch (error) {
    console.error(`[getClickUpPages] Error fetching ClickUp pages:`, error);
    throw error;
  }
}

async function upsertToDustDatasource(page: ClickUpPage) {
  console.log(`[upsertToDustDatasource] Upserting page: ${page.name}`);
  const slug = generateSlug(page.name);
  const documentId = `${page.id}-${slug}`;
  const createdDate = new Date(page.date_created).toISOString();
  const updatedDate = new Date(page.date_updated).toISOString();

  const content = `
Title: ${page.name}
Created At: ${createdDate}
Updated At: ${updatedDate}
Content:
${page.content}
  `.trim();

  try {
    console.log(`[upsertToDustDatasource] Making Dust API request for documentId: ${documentId}`);
    await limitedDustApiPost(
      `/w/${DUST_WORKSPACE_ID}/vaults/${DUST_VAULT_ID}/data_sources/${DUST_DATASOURCE_ID}/documents/${documentId}`,
      {
        text: content,
        source_url: `https://app.clickup.com/${CLICKUP_WORKSPACE_ID}/v/dc/${CLICKUP_DOC_ID}/${page.id}`
      }
    );
    console.log(`[upsertToDustDatasource] Upserted page '${documentId}' to Dust datasource`);
  } catch (error) {
    console.error(`[upsertToDustDatasource] Error upserting page '${documentId}' to Dust datasource:`, error);
  }
}

async function processPages(pages: ClickUpPage[]) {
  console.log(`[processPages] Processing ${pages.length} pages`);
  for (const page of pages) {
    console.log(`[processPages] Processing page: ${page.name}`);
    // skip empty pages
    if (page.content && page.content.trim() !== '') {
      if (!page.archived) {
        await upsertToDustDatasource(page);
      } else {
        console.log(`[processPages] Skipping archived page: ${page.name}`);
      }
    }

    if (page.pages && page.pages.length > 0) {
      console.log(`[processPages] Page ${page.name} has child pages.`);
      await processPages(page.pages);
    }
  }
}

async function main() {
  console.log('[main] Starting main function');
  try {
    const pages = await getClickUpPages(CLICKUP_DOC_ID!);
    console.log(`[main] Retrieved ${pages.length} pages from ClickUp.`);
    await processPages(pages);
    console.log('[main] All pages processed successfully.');
  } catch (error) {
    console.error('[main] An error occurred:', error);
  }
}

main();