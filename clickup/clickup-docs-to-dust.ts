import axios, { AxiosResponse } from "axios";
import * as dotenv from "dotenv";
import Bottleneck from "bottleneck";
import slugify from "slugify";

dotenv.config();

// source
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const CLICKUP_WORKSPACE_ID = process.env.CLICKUP_WORKSPACE_ID;

// destination
const DUST_API_KEY = process.env.DUST_API_KEY;
const DUST_WORKSPACE_ID = process.env.DUST_WORKSPACE_ID;
const DUST_DATASOURCE_ID = process.env.DUST_DATASOURCE_ID;
const DUST_VAULT_ID = process.env.DUST_VAULT_ID;

const missingEnvVars = [
  ["CLICKUP_API_KEY", CLICKUP_API_KEY],
  ["CLICKUP_WORKSPACE_ID", CLICKUP_WORKSPACE_ID],
  ["DUST_API_KEY", DUST_API_KEY],
  ["DUST_WORKSPACE_ID", DUST_WORKSPACE_ID],
  ["DUST_DATASOURCE_ID", DUST_DATASOURCE_ID],
  ["DUST_VAULT_ID", DUST_VAULT_ID],
]
  .filter(([name, value]) => !value)
  .map(([name]) => name);

if (missingEnvVars.length > 0) {
  throw new Error(
    `Please provide values for the following environment variables in the .env file: ${missingEnvVars.join(", ")}`,
  );
}

// Create a Bottleneck limiter for ClickUp API
const clickupLimiter = new Bottleneck({
  minTime: 3000, // 3 seconds between requests
  maxConcurrent: 1, // Only 1 request at a time
});

const clickupApi = axios.create({
  baseURL: "https://api.clickup.com/api/v3",
  headers: {
    Authorization: CLICKUP_API_KEY,
    "Content-Type": "application/json",
  },
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

// Wrap axios methods with rate limiting
const limitedClickupGet = clickupLimiter.wrap(
  (url: string, config?: any) => clickupApi.get(url, config)
);

clickupApi.interceptors.response.use(
  (response) => {
    console.log(`Endpoint: ${response.config.url}, Status: ${response.status}`);
    return response;
  },
  (error) => {
    if (error.response && error.response.status === 429) {
      console.error(
        `Endpoint: ${error.config.url}, Rate limit exceeded. Please wait before making more requests.`,
      );
    }
    return Promise.reject(error);
  },
);

// Create a Bottleneck limiter for Dust API
const dustLimiter = new Bottleneck({
  minTime: 3000, // 3 seconds between requests
  maxConcurrent: 1, // Only 1 request at a time
});

const dustApi = axios.create({
  baseURL: "https://dust.tt/api/v1",
  headers: {
    Authorization: `Bearer ${DUST_API_KEY}`,
    "Content-Type": "application/json",
  },
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

// Wrap dustApi.post with the limiter
const limitedDustApiPost = dustLimiter.wrap(
  (url: string, data: any, config?: any) => dustApi.post(url, data, config),
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
    trim: true,
  });
}

async function getClickUpPages(docId: string): Promise<ClickUpPage[]> {
  try {
    const response: AxiosResponse<ClickUpPage[]> = await limitedClickupGet(
      `/workspaces/${CLICKUP_WORKSPACE_ID}/docs/${docId}/pages`,
      {
        params: {
          max_page_depth: -1,
          content_format: "text/md",
        },
      },
    );
    console.log(`Retrieved ${response.data.length} pages from ClickUp`);
    return response.data;
  } catch (error) {
    console.error("Error fetching ClickUp pages:", error);
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
        source_url: `https://app.clickup.com/${CLICKUP_WORKSPACE_ID}/v/dc/${page.doc_id}/${page.id}`,
      },
    );
    console.log(
      `Upserted page '${documentId}' https://app.clickup.com/${CLICKUP_WORKSPACE_ID}/v/dc/${page.doc_id}/${page.id} to Dust datasource`,
    );
  } catch (error) {
    console.error(
      `Error upserting page '${documentId}' to Dust datasource:`,
      error,
    );
  }
}

async function processPages(pages: ClickUpPage[], depth = 0): Promise<number> {
  let upsertedCount = 0;
  for (const page of pages) {
    const indent = "  ".repeat(depth);
    // skip empty pages
    if (page.content && page.content.trim() !== "") {
      if (!page.archived) {
        console.log(`${indent}Processing page: ${page.name}`);
        await upsertToDustDatasource(page);
        upsertedCount++;
      } else {
        console.log(`${indent}Skipping archived page: ${page.name}`);
      }
    }

    if (page.pages && page.pages.length > 0) {
      upsertedCount += await processPages(page.pages, depth + 1);
    }
  }
  return upsertedCount;
}

async function getAllDocs(): Promise<string[]> {
  try {
    const response = await clickupApi.get(`/workspaces/${CLICKUP_WORKSPACE_ID}/docs`);
    return response.data.docs.map((doc: any) => doc.id);
  } catch (error) {
    console.error("Error fetching docs:", error);
    throw error;
  }
}

async function main() {
  try {
    let totalUpsertedDocs = 0;
    const docIds = await getAllDocs();
    console.log(`Found ${docIds.length} documents in workspace`);
    
    for (const docId of docIds) {
      try {
        console.log(`Processing document ${docId}...`);
        const pages = await getClickUpPages(docId);
        const documentUpsertCount = await processPages(pages);
        totalUpsertedDocs += documentUpsertCount;
        console.log(`Document ${docId} processed successfully.`);
      } catch (error) {
        console.error(`Error processing document ${docId}:`, error);
        // Continue with next document
        continue;
      }
    }
    console.log(`All documents processed successfully. Total pages upserted: ${totalUpsertedDocs}`);
  } catch (error) {
    console.error("An error occurred:", error);
  }
}

main();
