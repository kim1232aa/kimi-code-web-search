import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateFetchUrl,
  validateFetchDns,
  FetchSecurityError,
} from "../src/host/fetch-security.ts";

describe("fetch-security: SSRF, URL, and DNS validation", () => {
  it("allows valid public HTTPS and HTTP URLs", () => {
    const u1 = validateFetchUrl("https://example.com/articles/123?q=test");
    assert.equal(u1.href, "https://example.com/articles/123?q=test");

    const u2 = validateFetchUrl("http://93.184.216.34/index.html");
    assert.equal(u2.href, "http://93.184.216.34/index.html");
  });

  it("blocks userinfo credentials in URLs", () => {
    const userinfoUrls = [
      "https://user:password@example.com/page",
      "http://admin:secret@public-domain.com/",
      "http://user@example.com/path",
    ];

    for (const url of userinfoUrls) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_INVALID_URL");
          assert(err.message.includes("userinfo"));
          return true;
        },
      );
    }
  });

  it("blocks non-HTTP protocols", () => {
    const invalidProtocols = [
      "file:///etc/passwd",
      "ftp://ftp.example.com/file.txt",
      "gopher://gopher.example.com",
      "data:text/html,<h1>Hello</h1>",
      "javascript:alert(1)",
      "ws://example.com/socket",
      "wss://example.com/socket",
    ];

    for (const url of invalidProtocols) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_INVALID_URL");
          return true;
        },
        `Expected ${url} to be rejected with WEB_INVALID_URL`,
      );
    }
  });

  it("blocks named local/internal hosts", () => {
    const blockedHosts = [
      "http://localhost/admin",
      "http://localhost:8080/metrics",
      "http://app.localhost/debug",
      "http://server.local/api",
      "http://service.internal/secret",
      "http://router.lan/config",
      "http://myhost.localdomain",
    ];

    for (const url of blockedHosts) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
        `Expected ${url} to be blocked with WEB_FETCH_BLOCKED`,
      );
    }
  });

  it("blocks loopback IPv4 addresses (127.0.0.0/8 and 0.0.0.0)", () => {
    const loopbacks = [
      "http://127.0.0.1:3000",
      "http://127.0.0.2:8080",
      "http://127.255.255.254",
      "http://0.0.0.0:80",
    ];

    for (const url of loopbacks) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
      );
    }
  });

  it("blocks RFC1918 private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)", () => {
    const privates = [
      "http://10.0.0.1/status",
      "http://10.254.1.2:8080",
      "http://172.16.0.1/",
      "http://172.24.10.5/",
      "http://172.31.255.255/",
      "http://192.168.1.1/admin",
      "http://192.168.0.100:5000",
    ];

    for (const url of privates) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
      );
    }
  });

  it("blocks cloud metadata address (169.254.169.254) and link-local ranges", () => {
    const linkLocals = [
      "http://169.254.169.254/latest/meta-data/",
      "http://169.254.1.1/",
    ];

    for (const url of linkLocals) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
      );
    }
  });

  it("blocks loopback and local IPv6 addresses", () => {
    const ipv6Locals = [
      "http://[::1]/debug",
      "http://[::]/admin",
      "http://[fe80::1ff:fe23:4567:890a]/",
      "http://[fc00::1]/",
      "http://[fd12:3456:789a:1::1]/",
      "http://[::ffff:127.0.0.1]/",
    ];

    for (const url of ipv6Locals) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
      );
    }
  });

  it("rejects empty, whitespace, and malformed URLs", () => {
    const malformed = ["", "   ", "not-a-valid-url", "://missing-scheme"];
    for (const url of malformed) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_INVALID_URL");
          return true;
        },
      );
    }
  });

  it("resolves DNS and blocks domains resolving to private / loopback IP spaces", async () => {
    // 1. Mock DNS resolving to 127.0.0.1
    const mockLoopbackLookup = async () => [{ address: "127.0.0.1", family: 4 }];
    await assert.rejects(
      () => validateFetchDns("evil-rebinding.example.com", mockLoopbackLookup),
      (err: unknown) => {
        assert(err instanceof FetchSecurityError);
        assert.equal(err.code, "WEB_FETCH_BLOCKED");
        assert(err.message.includes("127.0.0.1"));
        return true;
      },
    );

    // 2. Mock DNS resolving to 10.0.0.5 or 192.168.1.1
    const mockPrivateLookup = async () => [{ address: "10.0.0.5", family: 4 }];
    await assert.rejects(
      () => validateFetchDns("internal-service.example.com", mockPrivateLookup),
      (err: unknown) => {
        assert(err instanceof FetchSecurityError);
        assert.equal(err.code, "WEB_FETCH_BLOCKED");
        assert(err.message.includes("10.0.0.5"));
        return true;
      },
    );

    // 3. Mock DNS resolving to cloud metadata 169.254.169.254
    const mockMetaLookup = async () => [{ address: "169.254.169.254", family: 4 }];
    await assert.rejects(
      () => validateFetchDns("cloud-meta.example.com", mockMetaLookup),
      (err: unknown) => {
        assert(err instanceof FetchSecurityError);
        assert.equal(err.code, "WEB_FETCH_BLOCKED");
        return true;
      },
    );

    // 4. Mock DNS resolving to ::1 or fe80::
    const mockIpv6Lookup = async () => [{ address: "::1", family: 6 }];
    await assert.rejects(
      () => validateFetchDns("ipv6-loop.example.com", mockIpv6Lookup),
      (err: unknown) => {
        assert(err instanceof FetchSecurityError);
        assert.equal(err.code, "WEB_FETCH_BLOCKED");
        return true;
      },
    );

    // 5. Mock DNS resolving to legitimate public IP (93.184.216.34)
    const mockPublicLookup = async () => [{ address: "93.184.216.34", family: 4 }];
    await validateFetchDns("example.com", mockPublicLookup);
  });

  it("blocks FQDN trailing-dot local/internal hostnames", () => {
    const fqdnBlocked = [
      "http://localhost./admin",
      "http://app.localhost./debug",
      "http://service.internal./secret",
      "http://printer.local./status",
    ];
    for (const url of fqdnBlocked) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
        `Expected ${url} to be blocked with WEB_FETCH_BLOCKED`,
      );
    }
  });

  it("blocks IPv4-compatible, NAT64, private 6to4, and uncompressed IPv4-mapped IPv6 forms", () => {
    const blockedIpv6 = [
      "http://[::127.0.0.1]/",
      "http://[::7f00:1]/",
      "http://[64:ff9b::127.0.0.1]/",
      "http://[64:ff9b::8.8.8.8]/",
      "http://[2002:7f00:1::]/",
      "http://[2002:a9fe:a9fe::]/",
      "http://[2002:c0a8:0101::]/",
      "http://[0000:0000:0000:0000:0000:ffff:7f00:0001]/",
      "http://[0000:0000:0000:0000:0000:ffff:127.0.0.1]/",
    ];
    for (const url of blockedIpv6) {
      assert.throws(
        () => validateFetchUrl(url),
        (err: unknown) => {
          assert(err instanceof FetchSecurityError);
          assert.equal(err.code, "WEB_FETCH_BLOCKED");
          return true;
        },
        `Expected ${url} to be blocked with WEB_FETCH_BLOCKED`,
      );
    }

    // 6to4 embedding public IPv4 (93.184.216.34 = 5db8:d822) remains allowed
    const pub6to4 = validateFetchUrl("http://[2002:5db8:d822::1]/");
    assert.equal(pub6to4.hostname, "[2002:5db8:d822::1]");
  });

  it("validateFetchDns removes abort listener on completion and swallows late aborted lookup rejection", async () => {
    const controller = new AbortController();
    let listeners = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, fn: any, opts?: any) => {
      if (type === "abort") listeners += 1;
      return origAdd(type, fn, opts);
    }) as any;
    controller.signal.removeEventListener = ((type: string, fn: any, opts?: any) => {
      if (type === "abort") listeners -= 1;
      return origRemove(type, fn, opts);
    }) as any;

    await validateFetchDns("example.com", async () => [{ address: "93.184.216.34", family: 4 }], controller.signal);
    assert.equal(listeners, 0, "abort listener must be removed after DNS completes");

    let rejectLookup!: (err: Error) => void;
    const lookupPromise = new Promise<Array<{ address: string; family: number }>>((_, reject) => {
      rejectLookup = reject;
    });
    const pending = validateFetchDns("slow.example.com", () => lookupPromise, controller.signal);
    controller.abort(new Error("aborted"));
    await assert.rejects(() => pending, (err: unknown) => err instanceof FetchSecurityError);
    assert.equal(listeners, 0);

    // Trigger late lookup rejection to ensure no unhandledRejection occurs
    rejectLookup(new Error("late DNS failure"));
    await new Promise((r) => setTimeout(r, 10));
  });
});
