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
  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response: AxiosResponse<ClickUpPage[]> = await clickupApi.get(
        `/workspaces/${CLICKUP_WORKSPACE_ID}/docs/${docId}/pages`,
        {
          params: {
            max_page_depth: 1, // Only get immediate children
            content_format: 'text/md'
          }
        }
      );
      
      const pages = response.data;
      console.log(`Retrieved ${pages.length} immediate pages from ClickUp`);
      
      // Recursively fetch subpages
      for (const page of pages) {
        if (page.pages && page.pages.length > 0) {
          try {
            const subPages = await getClickUpPagesWithRetry(page.id);
            page.pages = subPages;
          } catch (error) {
            console.error(`Failed to fetch subpages for ${page.id}:`, error.message);
            page.pages = [];
          }
        }
      }
      
      return pages;
    } catch (error) {
      lastError = error;
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error.message);
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
      }
    }
  }
  throw lastError;
});

clickupApi.interceptors.response.use(
  (response) => {
    console.log(`Endpoint: ${response.config.url}, Status: ${response.status}`);
    return response;
  },
  (error) => {
    if (error.response && error.response.status === 429) {
      console.error(`Endpoint: ${error.config.url}, Rate limit exceeded. Please wait before making more requests.`);
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
  return slugify(name, {
    lower: true,
    strict: true,
    trim: true
  });
}

async function getClickUpPages(docId: string): Promise<ClickUpPage[]> {
  try {
    return await getClickUpPagesWithRetry(docId);
  } catch (error) {
    console.error('Error fetching ClickUp pages after all retries:', error);
    throw error;
  }
}

async function upsertToDustDatasource(page: ClickUpPage) {
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
    await limitedDustApiPost(
      `/w/${DUST_WORKSPACE_ID}/vaults/${DUST_VAULT_ID}/data_sources/${DUST_DATASOURCE_ID}/documents/${documentId}`,
      {
        text: content,
        source_url: `https://app.clickup.com/${CLICKUP_WORKSPACE_ID}/v/dc/${CLICKUP_DOC_ID}/${page.id}`
      }
    );
    console.log(`Upserted page '${documentId}' https://app.clickup.com/${CLICKUP_WORKSPACE_ID}/v/dc/${CLICKUP_DOC_ID}/${page.id} to Dust datasource`);
  } catch (error) {
    console.error(`Error upserting page '${documentId}') to Dust datasource:`, error);
  }
}

async function processPages(pages: ClickUpPage[], batchSize = 5) {
  const flattenPages = (pages: ClickUpPage[]): ClickUpPage[] => {
    let result: ClickUpPage[] = [];
    for (const page of pages) {
      if (page.content && page.content.trim() !== '' && !page.archived) {
        result.push(page);
      }
      if (page.pages && page.pages.length > 0) {
        result = result.concat(flattenPages(page.pages));
      }
    }
    return result;
  };

  const allPages = flattenPages(pages);
  console.log(`Total pages to process: ${allPages.length}`);

  for (let i = 0; i < allPages.length; i += batchSize) {
    const batch = allPages.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(allPages.length/batchSize)}`);
    
    await Promise.all(
      batch.map(page => upsertToDustDatasource(page))
    );
    
    // Wait a bit between batches to avoid overwhelming the API
    if (i + batchSize < allPages.length) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function main() {
  try {
    const pages = await getClickUpPages(CLICKUP_DOC_ID!);
    await processPages(pages);
    console.log('All pages processed successfully.');
  } catch (error) {
    console.error('An error occurred:', error);
  }
}

main();
