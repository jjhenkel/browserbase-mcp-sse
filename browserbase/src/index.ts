import express, { Request, Response } from "express";
import { z } from "zod";
import puppeteer, { Browser, Page } from "puppeteer-core";
import { Browserbase } from "@browserbasehq/sdk";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

/**
 * -------------------------
 * 1) Handle Max Session Limit
 * -------------------------
 *
 * We attempt to read from:
 *    - Environment variable: MAX_SESSIONS
 *    - Command line arg: e.g. `node app.js 3`
 *
 * If neither is provided, defaults to 1.
 */
function parseMaxSessions(): number {
  const defaultMax = 1;
  // Prefer environment variable
  let maxSessions = parseInt(process.env.MAX_SESSIONS || "", 10);

  if (Number.isNaN(maxSessions) || !maxSessions) {
    // If the first argument is a number, use that
    const cliArg = process.argv[2];
    const cliNumber = cliArg ? parseInt(cliArg, 10) : NaN;
    if (!Number.isNaN(cliNumber) && cliNumber > 0) {
      maxSessions = cliNumber;
    } else {
      maxSessions = defaultMax;
    }
  }
  return maxSessions;
}

const MAX_SESSIONS = parseMaxSessions();

/**
 * -------------------------
 * 2) & 3) Improve/Robustify Session Management
 * -------------------------
 *
 * We store all active sessions in a Map keyed by a "user-friendly ID" (like Docker's random naming).
 * Tools will attempt to find a session by ID, or create a new one if none is found / none exists, etc.
 */
interface SessionData {
  browser: Browser;
  page: Page;
}

const activeSessions = new Map<string, SessionData>();
const consoleLogs: string[] = [];
const screenshots = new Map<string, string>();

// If the user never explicitly sets a default session, we can track it here:
let defaultSessionId: string | undefined;

/**
 * Generate a Docker-like user-friendly name if the user does not supply one.
 * This is a simple example with a few adjectives/nouns. Feel free to expand.
 */
function generateDockerLikeName(): string {
  const adjectives = [
    "adorable","brave","calm","dazzling","eager",
    "fancy","gentle","happy","jolly","kind",
    "lively","mighty","nice","proud","quirky",
    "silly","tiny","unique","vibrant","witty",
  ];
  const nouns = [
    "ant","bee","cat","dog","eagle",
    "fox","goat","hedgehog","ibis","jaguar",
    "koala","lion","monkey","narwhal","otter",
    "panda","quokka","rabbit","shark","tiger",
    "unicorn","viper","wolf","xenops","yak","zebra",
  ];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  // Optional short random suffix
  const suffix = Math.random().toString(36).substring(2, 4);
  return `${adjective}-${noun}-${suffix}`;
}

function notify_message(message: string, type: string): void {
  // Only attempt notification if there is at least one active transport.
  if (Object.keys(transports).length === 0) return;

  // Fire-and-forget the async notification, handling any errors.
  server.server
    .notification({
      method: "notifications/cloud/message",
      params: { message, type },
    })
    .catch((error) => {
      console.error(`Notification failed: ${(error as Error).message}`);
    });
}

function notify_resource_changed(): void {
  // Only attempt notification if there is at least one active transport
  if (Object.keys(transports).length === 0) return;

  // Fire-and-forget the async notification, handling any errors.
  server.server
    .notification({
      method: "notifications/resources/list_changed",
    })
    .catch((error) => {
      console.error(`Notification failed: ${(error as Error).message}`);
    }
  );
}

/**
 * Create a new Browserbase session, up to MAX_SESSIONS limit.
 */
async function createNewBrowserSession(
  requestedSessionId?: string
): Promise<{ sessionId: string; browser: Browser; page: Page }> {
  if (activeSessions.size >= MAX_SESSIONS) {
    throw new Error(
      `Cannot create session: maximum of ${MAX_SESSIONS} active sessions already in use.`
    );
  }

  // If the user asked for a specific sessionId, use it. Otherwise, generate a docker-like name.
  const sessionId = requestedSessionId || generateDockerLikeName();

  // Connect to Browserbase
  const bb = new Browserbase({
    apiKey: process.env.BROWSERBASE_API_KEY!,
  });
  const newSession = await bb.sessions.create({
    projectId: process.env.BROWSERBASE_PROJECT_ID!,
  });
  const browser = await puppeteer.connect({
    browserWSEndpoint: newSession.connectUrl,
  });

  const page = (await browser.pages())[0];
  activeSessions.set(sessionId, { browser, page });

  // Attach console logger
  page.on("console", (msg) => {
    const logEntry = `[Session ${sessionId}][${msg.type()}] ${msg.text()}`;
    consoleLogs.push(logEntry);
    notify_message(logEntry, "console_log");
  });

  // If there is no default session yet, or we just created the very first session, set it as default
  if (!defaultSessionId) {
    defaultSessionId = sessionId;
  }

  return { sessionId, browser, page };
}

/**
 * Get or create a session:
 *
 *  - If `targetSessionId` is provided and exists, return it.
 *  - If `targetSessionId` is provided but doesn't exist, create a new session (if allowed).
 *  - If no `targetSessionId` is provided:
 *      => if there are no sessions at all, create one.
 *      => else use the defaultSessionId (if that is missing, pick the first in the map).
 */
async function getOrCreateSession(
  targetSessionId?: string
): Promise<{ sessionId: string; browser: Browser; page: Page }> {
  // If user explicitly asked for a session
  if (targetSessionId) {
    const existing = activeSessions.get(targetSessionId);
    if (existing) {
      // Found a matching session
      return { sessionId: targetSessionId, ...existing };
    } else {
      // Create a new session with that requested ID (if not at limit)
      const newSession = await createNewBrowserSession(targetSessionId);
      return newSession;
    }
  }

  // If no session ID given:
  if (activeSessions.size === 0) {
    // No sessions exist: create new
    const newSession = await createNewBrowserSession();
    return newSession;
  } else {
    // Sessions exist: prefer default if we have one
    if (!defaultSessionId || !activeSessions.has(defaultSessionId)) {
      // If defaultSessionId is missing or invalid, pick the first in the map
      defaultSessionId = activeSessions.keys().next().value;
    }

    // Return the default
    const existingSession = activeSessions.get(defaultSessionId!);
    if (!existingSession) {
      // Edge case fallback - shouldn't happen unless map changed in the middle
      const newSession = await createNewBrowserSession();
      return newSession;
    }
    return { sessionId: defaultSessionId!, ...existingSession };
  }
}

/**
 * Close and remove a session from the map
 */
async function closeBrowserSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (session) {
    await session.browser.close().catch(() => {
      /* ignore close errors */
    });
    activeSessions.delete(sessionId);
    // If that was the default, clear it or point default to something else
    if (defaultSessionId === sessionId) {
      defaultSessionId = activeSessions.size > 0
        ? activeSessions.keys().next().value
        : undefined;
    }
  } else {
    throw new Error(`Session '${sessionId}' not found.`);
  }
}

/**
 * -------------------------
 * 4) The MCP Server Setup
 * -------------------------
 */
const server = new McpServer({
  name: "Browserbase",
  version: "1.0.2",
});

// Ensure environment variables are defined
["BROWSERBASE_API_KEY", "BROWSERBASE_PROJECT_ID"].forEach((envName) => {
  if (!process.env[envName]) {
    throw new Error(`${envName} environment variable is required`);
  }
});

/**
 * -------------------------
 * 6) Tools with Clear Descriptions
 * -------------------------
 */

/**
 * 1) browserbase_list_sessions
 *    Lists all Browserbase sessions (on the Browserbase side, not just local).
 */
server.tool(
  "browserbase_list_sessions",
  `List all sessions on Browserbase's side (this may differ from local active sessions). 
   No arguments required. By default, filters to 'RUNNING' sessions.`,
  {
    status: z
      .string()
      .describe(
        "Optional status to filter sessions by ('RUNNING' | 'ERROR' | 'TIMED_OUT' | 'COMPLETED')."
      )
      .optional(),
  },
  async ({ status }) => {
    try {
      let safeStatus: (
        'RUNNING' | 'ERROR' | 'TIMED_OUT' | 'COMPLETED'
      ) = (
        status?.toUpperCase() ?? 'RUNNING'
      ) as (
        'RUNNING' | 'ERROR' | 'TIMED_OUT' | 'COMPLETED'
      );

      if (!['RUNNING', 'ERROR', 'TIMED_OUT', 'COMPLETED'].includes(safeStatus)) {
        safeStatus = 'RUNNING';
      }

      const bb = new Browserbase({
        apiKey: process.env.BROWSERBASE_API_KEY!,
      });
      const sessions = await bb.sessions.list({
        status: safeStatus,
      });
      if (!sessions || sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sessions found on Browserbase side.",
            },
          ],
          isError: false,
        };
      } else {
        // Arbitrarily set defaultSessionId to the first returned (this might not be connected locally, though).
        defaultSessionId = sessions[0].id;
        const sessionIds = sessions.map((s) => s.id).join(", ");
        return {
          content: [
            {
              type: "text",
              text:
                `Browserbase currently knows about ${sessions.length} sessions: ${sessionIds}` +
                `\n\nDefault session is now set to '${defaultSessionId}' (NOTE: might not match local).`,
            },
          ],
          isError: false,
        };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to list sessions: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 2) browserbase_create_session
 *    Create a new session locally (and in Browserbase) if under max session limit.
 */
server.tool(
  "browserbase_create_session",
  `Create a new cloud browser session using Browserbase, up to the maximum session limit (${MAX_SESSIONS}). 
   No arguments required.`,
  {},
  async () => {
    try {
      const { sessionId } = await createNewBrowserSession();
      return {
        content: [
          {
            type: "text",
            text: `Created new session with ID '${sessionId}'. Current count: ${activeSessions.size}/${MAX_SESSIONS}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to create session: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 3) browserbase_close_session
 *    Close an existing local session (and the underlying Browserbase session).
 */
server.tool(
  "browserbase_close_session",
  `Close a cloud browser session, removing it from local active sessions and terminating on Browserbase.`,
  {
    sessionId: z
      .string()
      .describe(
        "ID of the session to close. If omitted, the current default session is closed."
      )
      .optional(),
  },
  async ({ sessionId }) => {
    const target = sessionId || defaultSessionId;
    if (!target) {
      return {
        content: [
          {
            type: "text",
            text: "No session specified, and no default session is set.",
          },
        ],
        isError: true,
      };
    }
    try {
      await closeBrowserSession(target);
      return {
        content: [
          {
            type: "text",
            text: `Closed session '${target}'. Active sessions now: ${activeSessions.size}/${MAX_SESSIONS}`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: (error as Error).message,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 4) browserbase_navigate
 *    Navigate to a given URL in a chosen session.
 */
server.tool(
  "browserbase_navigate",
  `Navigate to a specific URL in a chosen (or default) session. 
   If no session exists at all, one is created. 
   If the chosen session ID does not exist, a new session is created with that ID.`,
  {
    url: z
      .string()
      .describe("The URL to navigate to (e.g. 'https://example.com')."),
    sessionId: z
      .string()
      .describe(
        "Optional specific session ID to use. If not provided, the default or a new session is used."
      )
      .optional(),
  },
  async ({ url, sessionId }) => {
    try {
      const { sessionId: finalId, page } = await getOrCreateSession(sessionId);
      await page.goto(url);
      return {
        content: [
          {
            type: "text",
            text: `Navigated to '${url}' in session '${finalId}'.`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to navigate to ${url}: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 5) browserbase_screenshot
 *    Take a screenshot in a chosen (or default) session.
 */
server.tool(
  "browserbase_screenshot",
  `Take a screenshot in the target session. 
   Optionally specify a selector to capture a specific element, and/or a custom viewport size.`,
  {
    name: z
      .string()
      .describe("A name to assign to this screenshot (used as an identifier)."),
    selector: z
      .string()
      .describe("CSS selector to capture a specific element. If omitted, captures full page.")
      .optional(),
    width: z
      .number()
      .describe("Viewport width in pixels (default 1024).")
      .optional(),
    height: z
      .number()
      .describe("Viewport height in pixels (default 800).")
      .optional(),
    sessionId: z
      .string()
      .describe(
        "Optional specific session ID to use. If not provided, the default or a new session is used."
      )
      .optional(),
  },
  async ({ name, selector, width, height, sessionId }) => {
    try {
      const { sessionId: finalId, page } = await getOrCreateSession(sessionId);
      await page.setViewport({ width: width ?? 1024, height: height ?? 800 });

      const target = selector ? await page.$(selector) : page;
      if (!target) {
        return {
          content: [
            {
              type: "text",
              text: `Element not found using selector '${selector}'.`,
            },
          ],
          isError: true,
        };
      }

      const screenshot = await target.screenshot({
        encoding: "base64",
        fullPage: false,
      });

      if (!screenshot) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to take screenshot named '${name}'.`,
            },
          ],
          isError: true,
        };
      }

      screenshots.set(name, screenshot as string);
      notify_resource_changed();

      return {
        content: [
          {
            type: "text",
            text: `Screenshot '${name}' taken in session '${finalId}'.` +
              (selector ? ` (Captured element '${selector}')` : ""),
          },
          {
            type: "image",
            data: screenshot,
            mimeType: "image/png",
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to take screenshot: ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 6) browserbase_click
 *    Click an element in the DOM of a chosen session.
 */
server.tool(
  "browserbase_click",
  `Click the element matching the given CSS selector in a chosen (or default) session.
   Creates a new session if none exist.`,
  {
    selector: z
      .string()
      .describe("CSS selector of the element to click, e.g. '#submit-button'."),
    sessionId: z
      .string()
      .describe(
        "Optional specific session ID to use. If not provided, the default or a new session is used."
      )
      .optional(),
  },
  async ({ selector, sessionId }) => {
    try {
      const { sessionId: finalId, page } = await getOrCreateSession(sessionId);
      await page.click(selector);
      return {
        content: [
          {
            type: "text",
            text: `Clicked element with selector '${selector}' in session '${finalId}'.`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to click element '${selector}': ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 7) browserbase_fill
 *    Fill an input/textarea in the DOM of a chosen session.
 */
server.tool(
  "browserbase_fill",
  `Fill text into an input (or similar) element in a chosen (or default) session.
   Creates a new session if none exist.`,
  {
    selector: z
      .string()
      .describe("CSS selector of the element to fill, e.g. 'input[name=email]'."),
    value: z.string().describe("The text to type into the element."),
    sessionId: z
      .string()
      .describe(
        "Optional specific session ID to use. If not provided, the default or a new session is used."
      )
      .optional(),
  },
  async ({ selector, value, sessionId }) => {
    try {
      const { sessionId: finalId, page } = await getOrCreateSession(sessionId);
      await page.waitForSelector(selector);
      await page.type(selector, value);
      return {
        content: [
          {
            type: "text",
            text: `Filled selector '${selector}' with '${value}' in session '${finalId}'.`,
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to fill element '${selector}': ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 8) browserbase_get_content
 *    Get text content from an element in the DOM of a chosen session.
 */
server.tool(
  "browserbase_get_content",
  `Fetch the text content of elements matching a CSS selector in a chosen (or default) session.
   Creates a new session if none exist.`,
  {
    selector: z
      .string()
      .describe("CSS selector of elements to fetch text from, e.g. '.article-title'."),
    sessionId: z
      .string()
      .describe(
        "Optional specific session ID to use. If not provided, the default or a new session is used."
      )
      .optional(),
  },
  async ({ selector, sessionId }) => {
    try {
      const { sessionId: finalId, page } = await getOrCreateSession(sessionId);
      const content = await page.evaluate((sel) => {
        const elements = document.querySelectorAll(sel);
        return Array.from(elements).map((element) => element.textContent || "");
      }, selector);

      if (!content) {
        return {
          content: [
            {
              type: "text",
              text: `No content found using selector '${selector}'.`,
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: `Content of elements with selector '${selector}' in session '${finalId}':`,
          },
          {
            type: "text",
            text: content.join("\n"),
          },
        ],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to get content from selector '${selector}': ${(error as Error).message}`,
          },
        ],
        isError: true,
      };
    }
  }
);

/**
 * 9) browserbase_status
 *    Show how many sessions are used vs max, and the active session details.
 */
server.tool(
  "browserbase_status",
  `Show the status of current session usage: 
   - how many sessions in use, 
   - how many allowed (MAX_SESSIONS), 
   - available session IDs, 
   - and the current page URL for each session.`,
  {},
  async () => {
    if (activeSessions.size === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No active sessions. Maximum allowed is ${MAX_SESSIONS}.`,
          },
        ],
        isError: false,
      };
    }

    let responseText = `Active Sessions: ${activeSessions.size}/${MAX_SESSIONS}\n`;
    for (const [id, { page }] of activeSessions.entries()) {
      responseText += `- Session ID: '${id}' ${
        id === defaultSessionId ? "(default)" : ""
      } | Current URL: ${page.url()}\n`;
      // Should check if it's detached or not
      if (page.isClosed()) {
        responseText += "  ! WARNING: this session's page is closed!\n";
        responseText += "  ! You'd need to close/re-create the session to use it again.\n";
      }
    }

    return {
      content: [
        {
          type: "text",
          text: responseText,
        },
      ],
      isError: false,
    };
  }
);

/**
 * -------------------------
 * 5) Session & Resource Endpoints
 * -------------------------
 */

/**
 * Resource for console logs
 */
server.resource(
  "console-logs",
  "console://logs",
  {
    description: "Console logs from cloud browser sessions",
    mimeType: "text/plain",
  },
  async () => {
    return {
      contents: [
        {
          uri: "console://logs",
          text: consoleLogs.join("\n"),
        },
      ],
    };
  }
);

/**
 * Resource for screenshots
 */
server.resource(
  "screenshots",
  new ResourceTemplate("screenshot://{name}", { list: undefined }),
  {
    description: "Screenshots taken in cloud browser sessions",
    mimeType: "image/png",
  },
  async (uri: URL) => {
    const name = uri.pathname.split("/").pop()!;
    const data = screenshots.get(name);

    if (!data) {
      // Return nothing if screenshot not found
      return {
        contents: [],
      };
    }

    return {
      contents: [
        {
          uri: `screenshot://${name}`,
          blob: data,  // Already base64 encoded
        },
      ],
    };
  }
);

/**
 * -------------------------
 * Express + SSEServerTransport Setup
 * -------------------------
 */
const app = express();
const transports: {[transportSessionId: string]: SSEServerTransport} = {};

/**
 * SSE Endpoint
 */
app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/message", res);
  console.log(`Connecting to transport with ID ${transport.sessionId}`);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    console.log(`Transport with ID ${transport.sessionId} closed`);
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

/**
 * POST endpoint for SSE messages
 */
app.post("/message", express.json(), async (req: Request, res: Response) => {
  const transportSessionId = req.query.sessionId as string;
  const transport = transports[transportSessionId];
  if (transport) {
    await transport.handlePostMessage(req, res, req.body);
  } else {
    res.status(404).send(`No transport found for session ID ${transportSessionId}`);
  }
});

/**
 * Start listening
 */
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`Listening on port ${PORT} (max sessions = ${MAX_SESSIONS})`);
});
