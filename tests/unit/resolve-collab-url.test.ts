import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveCollabWsUrl } from "../../app/editor/[docId]/page";

describe("Résolution dynamique de l'URL WebSocket de collaboration (resolveCollabWsUrl)", () => {
  const originalWindow = global.window;
  const originalEnv = process.env.NEXT_PUBLIC_COLLAB_URL;

  function mockWindowLocation(loc: { hostname: string; host: string; protocol: string }) {
    global.window = {
      location: loc,
    } as unknown as Window & typeof globalThis;
  }

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_COLLAB_URL;
  });

  afterEach(() => {
    global.window = originalWindow;
    if (originalEnv !== undefined) {
      process.env.NEXT_PUBLIC_COLLAB_URL = originalEnv;
    } else {
      delete process.env.NEXT_PUBLIC_COLLAB_URL;
    }
  });

  it("retourne ws://localhost:1234 côté serveur (SSR / window undefined)", () => {
    // @ts-expect-error simule SSR
    delete global.window;
    expect(resolveCollabWsUrl()).toBe("ws://localhost:1234");
  });

  it("retourne ws://localhost:1234 si le navigateur est sur localhost", () => {
    mockWindowLocation({
      hostname: "localhost",
      host: "localhost:3000",
      protocol: "http:",
    });
    expect(resolveCollabWsUrl()).toBe("ws://localhost:1234");
  });

  it("retourne ws://localhost:1234 si le navigateur est sur 127.0.0.1", () => {
    mockWindowLocation({
      hostname: "127.0.0.1",
      host: "127.0.0.1:3000",
      protocol: "http:",
    });
    expect(resolveCollabWsUrl()).toBe("ws://localhost:1234");
  });

  it("résout wss://<cloudfront>/collab en HTTPS sur CloudFront", () => {
    mockWindowLocation({
      hostname: "d3eg6zl3hu2tvv.cloudfront.net",
      host: "d3eg6zl3hu2tvv.cloudfront.net",
      protocol: "https:",
    });
    expect(resolveCollabWsUrl()).toBe("wss://d3eg6zl3hu2tvv.cloudfront.net/collab");
  });

  it("résout ws://<ip>/collab en HTTP sur une IP ou domaine externe", () => {
    mockWindowLocation({
      hostname: "51.20.10.30",
      host: "51.20.10.30",
      protocol: "http:",
    });
    expect(resolveCollabWsUrl()).toBe("ws://51.20.10.30/collab");
  });

  it("ignore un NEXT_PUBLIC_COLLAB_URL pointant sur localhost quand on est en prod sur CloudFront", () => {
    process.env.NEXT_PUBLIC_COLLAB_URL = "ws://localhost:1234";
    mockWindowLocation({
      hostname: "d3eg6zl3hu2tvv.cloudfront.net",
      host: "d3eg6zl3hu2tvv.cloudfront.net",
      protocol: "https:",
    });
    // Doit impérativement router vers /collab de CloudFront et ignorer localhost
    expect(resolveCollabWsUrl()).toBe("wss://d3eg6zl3hu2tvv.cloudfront.net/collab");
  });

  it("respecte une URL absolue explicite non-localhost", () => {
    process.env.NEXT_PUBLIC_COLLAB_URL = "wss://collab.example.org";
    mockWindowLocation({
      hostname: "app.example.org",
      host: "app.example.org",
      protocol: "https:",
    });
    expect(resolveCollabWsUrl()).toBe("wss://collab.example.org");
  });

  it("gère un chemin relatif pour NEXT_PUBLIC_COLLAB_URL", () => {
    process.env.NEXT_PUBLIC_COLLAB_URL = "/custom-collab-path";
    mockWindowLocation({
      hostname: "d3eg6zl3hu2tvv.cloudfront.net",
      host: "d3eg6zl3hu2tvv.cloudfront.net",
      protocol: "https:",
    });
    expect(resolveCollabWsUrl()).toBe("wss://d3eg6zl3hu2tvv.cloudfront.net/custom-collab-path");
  });
});
