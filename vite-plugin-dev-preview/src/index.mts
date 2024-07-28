import { type Connect, type Plugin, ViteDevServer } from "vite";
import { ServerResponse } from "node:http";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Determines how the dev-preview plugin works.
 */
export interface DevPreviewOptions {
  /**
   * The url that exposes preview functionality; the file path of the file to preview is appended to this.
   *
   * Defaults to `/$/dev-preview/`
   */
  urlPrefix?: string;

  /**
   * What file extensions to lookup when determining what to preview.
   *
   * Defaults to ['.tsx', '.ts', '.jsx', '.js']
   */
  extensions?: string[];

  /**
   * What suffixes to apply to the file for previewing.
   *
   * Defaults to []
   */
  suffixes?: string[];

  /**
   * The name of the html file to load when previewing file.  The plugin will walk up the directory tree looking for
   * files with this name until it finds one that exists.
   *
   * The file must contain `htmlPlaceholder` where the module being previewed will be inserted.
   *
   * Defaults to `dev.html`
   */
  htmlFilename?: string;

  /**
   * The text in `htmlFilename` to replace with the import of the file being previewed.
   *
   * Defaults to `<!-- placeholder -->`
   */
  htmlPlaceholder?: string;

  /**
   * Callback to be invoked when the plugin logs a warning message
   */
  logWarning?: (message: string) => void;
}

const defaultOptions: DevPreviewOptions = {
  urlPrefix: "/$/dev-preview/",
  extensions: [".tsx", ".ts", ".jsx", ".js"],
  htmlFilename: "dev.html",
  htmlPlaceholder: "<!-- placeholder -->",
};

/**
 * Vite plugin which renders a `filepath.dev.ts` file by reading in dev.html and importing `filepath.dev.ts`.  This
 * allows you to write a script to easily develop new features in an iterative fashion.
 */
export function viteDevPreview(options: DevPreviewOptions = {}): Plugin {
  options = { ...defaultOptions, ...options };

  let _server: ViteDevServer | null = null;

  const urlPrefix = options.urlPrefix!;
  const indexFile = options.htmlFilename!;
  const suffixes = [...(options.suffixes ?? []), ""];
  const extensions = options.extensions ?? [];
  const variants = [
    ...suffixes?.flatMap((suffix) => extensions.map((ext) => suffix + ext)),
  ];

  const handleRequest = async function (
    req: Connect.IncomingMessage,
    res: ServerResponse<Connect.IncomingMessage>,
    next: Connect.NextFunction,
  ) {
    const server = _server;
    if (server == null) {
      return;
    }

    const prefix = urlPrefix;
    if (!(req.originalUrl && req.originalUrl.startsWith(prefix))) {
      next();
      return;
    }

    const devFilePath = req.originalUrl!.substring(prefix.length);

    const resolveFile = async () => {
      for (const ext of variants) {
        const fullPath = devFilePath + ext;
        try {
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            return fullPath;
          }
        } catch (err) {
          if ((err as { code: string }).code !== "ENOENT") {
            // Other errors, might be permission related, etc.
            throw err;
          }
        }
      }

      return null;
    };

    const resolveDevFile = async (): Promise<string | null> => {
      let directory = path.dirname(devFilePath);

      do {
        const devFile = path.join(directory, indexFile);
        try {
          const stat = await fs.stat(devFile);
          if (stat.isFile()) {
            return devFile;
          }
        } catch (err) {
          if ((err as { code: string }).code !== "ENOENT") {
            // Other errors, might be permission related, etc.
            throw err;
          }
        }

        const newDirectory = path.dirname(directory);
        if (newDirectory == directory) {
          break;
        }

        directory = newDirectory;
      } while (directory.length > 0);

      return null;
    };

    try {
      const file = await resolveFile();
      if (file == null) {
        next();
        return;
      }

      const devFile = await resolveDevFile();
      if (devFile == null) {
        options.logWarning?.(
          `Wanted to preview '${devFilePath}' but no associated ${indexFile} found in directory tree`,
        );
        next();
        return;
      }

      const fileContents = await fs.readFile(devFile, "utf8");
      const transformed = fileContents.replace(
        "<!-- placeholder -->",
        `<script type="module" src="/${file}"></script>`,
      );

      const indexHtml = await server.transformIndexHtml(
        req.originalUrl!,
        transformed,
      );

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html");
      res.end(indexHtml, "utf-8");
    } catch (e: unknown) {
      server.ssrFixStacktrace(e as Error);
      console.error(e);
      next(e);
    }
  };

  return {
    name: "dev-preview",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      _server = server;

      server.middlewares.use(
        (
          req: Connect.IncomingMessage,
          res: ServerResponse<Connect.IncomingMessage>,
          next: Connect.NextFunction,
        ) => {
          handleRequest(req, res, next).finally();
        },
      );
    },
  } satisfies Plugin;
}
