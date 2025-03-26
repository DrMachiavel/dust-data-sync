# ClickUp to Dust Datasource Import

This script imports ClickUp data into a Dust datasource.
Supported data types:

### Doc pages
The script imports doc pages from ClickUp.
Fetches all documents from a workspace and upsert to Dust.

## Installation

1. Ensure you have Node.js (version 14 or higher) and npm installed on your system.

2. Clone this repository:

3. Install the dependencies:
   ```
   npm install
   ```

## Environment Setup

Create a `.env` file in the root directory of the project with the following variables:

```
# source
CLICKUP_API_KEY=your_clickup_api_key
CLICKUP_WORKSPACE_ID=your_clickup_space_id

# destination
DUST_API_KEY=your_dust_api_key
DUST_WORKSPACE_ID=your_dust_workspace_id
DUST_DATASOURCE_ID=your_dust_datasource_id
```

Replace the placeholder values with your actual ClickUp and Dust settings.

## Usage

To run the script:

*To import a given Doc Page (and subpages) from ClickUp's Knowledge Base:*
```
npm run docs
```

## How It Works

1. The script fetches all the page and subpages for a given `DocId` using ClickUp's API.
2. The collected data is then upserted to the specified Dust datasource, using the page ID as the document ID.

## Error Handling

The script includes error handling for rate limiting. If a rate limit is exceeded, it will wait before retrying the request.

## Building

To compile the TypeScript code to JavaScript:

```
npm run build
```

This will create a `dist` directory with the compiled JavaScript files.

## Dependencies

- axios: For making HTTP requests to Zendesk and Dust APIs
- dotenv: For loading environment variables
- slugify: For generating slugs from page titles

## Dev Dependencies

- @types/node: TypeScript definitions for Node.js
- tsx: For running TypeScript files directly
- typescript: The TypeScript compiler

## Notes

- Ensure you have the necessary permissions in both ClickUp and Dust to perform these operations.
- The Dust datasource must be created manually though the web UI.

## License

This project is licensed under the ISC License.
