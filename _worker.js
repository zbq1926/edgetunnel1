import { connect } from "cloudflare:sockets";

// ===================== 配置常量（统一英文，避免编码问题） =====================
const DEFAULT_CONFIG = {
  subPath: "sub-path",          // 订阅基础路径
  fakeWeb: "https://www.baidu.com", // 默认伪装网页
  preferredListUrl: "https://raw.githubusercontent.com/zbq1926/edgetunnel1/refs/heads/main/output.txt",
  nat64Prefix: "2a02:898:146:64::",
  dohAddress: "dns.alidns.com/dns-query",
  proxyIp: "sjc.o00o.ooo",
  // 协议关键词拆分（防特征检测）
  keywordSplit: {
    v2ray: ["v2", "ray"],
    clash: ["cla", "sh"],
    vless: ["vl", "ess"]
  }
};

// 初始化全局变量
let config = { ...DEFAULT_CONFIG };
let preferredList = [];
let verifyUUID = "";

// ===================== 入口函数 =====================
export default {
  async fetch(request, env) {
    // 1. 加载环境变量（覆盖默认配置）
    config = {
      ...DEFAULT_CONFIG,
      subPath: env.SUB_PATH ?? DEFAULT_CONFIG.subPath,
      fakeWeb: env.FAKE_WEB ?? DEFAULT_CONFIG.fakeWeb,
      preferredListUrl: env.TXT_URL ?? DEFAULT_CONFIG.preferredListUrl,
      nat64Prefix: env.NAT64 ?? DEFAULT_CONFIG.nat64Prefix,
      dohAddress: env.DOH ?? DEFAULT_CONFIG.dohAddress,
      proxyIp: env.PROXY_IP ?? DEFAULT_CONFIG.proxyIp
    };
    
    // 2. 生成验证UUID（基于订阅路径）
    verifyUUID = generateUUID(config.subPath);
    
    // 3. 解析请求基础信息
    const url = new URL(request.url);
    const upgradeHeader = request.headers.get("Upgrade");
    const isWsRequest = upgradeHeader === "websocket";
    const host = request.headers.get("Host");
    
    // 4. 路径配置（预编码）
    const encodedSubPath = encodeURIComponent(config.subPath);
    const pathConfig = {
      v2ray: `/${encodedSubPath}/${config.keywordSplit.v2ray.join("")}`,
      clash: `/${encodedSubPath}/${config.keywordSplit.clash.join("")}`,
      subInfo: `/${encodedSubPath}/info`,
      generalSub: `/${encodedSubPath}`
    };
    const isValidPath = Object.values(pathConfig).includes(url.pathname);

    // ===================== 非WS + 非合法路径 → 伪装网页/404 =====================
    if (!isWsRequest && !isValidPath) {
      return handleFakeWebRequest(request, url);
    }

    // ===================== 非WS + 合法路径 → 生成订阅配置 =====================
    if (!isWsRequest) {
      // 预加载优选列表（仅加载一次）
      if (preferredList.length === 0) {
        preferredList = await loadPreferredList();
      }

      switch (url.pathname) {
        case pathConfig.v2ray:
          return generateV2rayConfig(host);
        case pathConfig.clash:
          return generateClashConfig(host);
        case pathConfig.subInfo:
          return generateSubInfo(host);
        case pathConfig.generalSub:
          return handleGeneralSubRequest(request, host);
        default:
          return new Response("Invalid Path", { status: 404 });
      }
    }

    // ===================== WS请求 → 升级并建立传输管道 =====================
    if (isWsRequest) {
      return await upgradeWsRequest();
    }

    // 默认返回404
    return new Response(null, { status: 404 });
  }
};

// ===================== 核心功能函数 =====================

/**
 * 处理伪装网页请求（转发到目标网址）
 */
async function handleFakeWebRequest(request, url) {
  try {
    // 补全协议头（支持域名/完整URL）
    const targetBase = config.fakeWeb.startsWith("http") 
      ? config.fakeWeb 
      : `https://${config.fakeWeb}`;
    const targetUrl = new URL(targetBase);
    
    // 继承原请求的路径和查询参数
    targetUrl.pathname = url.pathname;
    targetUrl.search = url.search;

    // 构造转发请求（过滤冲突头信息）
    const forwardRequest = new Request(targetUrl.toString(), {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
      redirect: "follow"
    });
    // 移除可能导致转发失败的头
    forwardRequest.headers.delete("Host");
    forwardRequest.headers.delete("Origin");
    forwardRequest.headers.delete("Referer");

    const response = await fetch(forwardRequest);
    // 复制响应头并返回
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch (error) {
    console.error("[Fake Web Error]", error);
    return new Response("Fake Web Request Failed", { status: 500 });
  }
}

/**
 * 升级WS请求并建立双向传输管道
 */
async function upgradeWsRequest() {
  const wsPair = new WebSocketPair();
  const [clientWs, serverWs] = Object.values(wsPair);
  
  // 初始化WS连接
  serverWs.accept();
  serverWs.binaryType = "arraybuffer";
  serverWs.send(new Uint8Array([0, 0])); // 初始响应

  // 启动传输管道（绑定错误处理）
  startTransportPipeline(serverWs).catch(error => {
    console.error("[WS Pipeline Error]", error);
    if (serverWs.readyState === WebSocket.OPEN) {
      serverWs.close(1011, "Internal Error");
    }
  });

  // 返回101响应
  return new Response(null, {
    status: 101,
    webSocket: clientWs,
    headers: {
      "Upgrade": "websocket",
      "Connection": "Upgrade"
    }
  });
}

/**
 * 启动WS-TCP传输管道（核心转发逻辑）
 */
async function startTransportPipeline(serverWs) {
  let tcpSocket = null;
  let tcpWriter = null;
  let isFirstPacket = true;

  // 监听WS消息
  serverWs.addEventListener("message", async (event) => {
    try {
      if (isFirstPacket) {
        isFirstPacket = false;
        // 解析VLess头并建立TCP连接
        tcpSocket = await parseVlessHeaderAndConnect(event.data, serverWs);
        if (!tcpSocket) return;
        
        // 获取TCP写入器
        tcpWriter = tcpSocket.writable.getWriter();
      } else if (tcpWriter && tcpSocket.readyState === "open") {
        // 非首包直接写入TCP
        await tcpWriter.write(event.data);
      }
    } catch (error) {
      console.error("[WS Message Error]", error);
      cleanupConnection(serverWs, tcpSocket);
    }
  });

  // 监听WS关闭/错误（清理TCP连接）
  serverWs.addEventListener("close", () => cleanupConnection(serverWs, tcpSocket));
  serverWs.addEventListener("error", () => cleanupConnection(serverWs, tcpSocket));
}

/**
 * 解析VLess协议头并建立TCP连接（多策略降级）
 */
async function parseVlessHeaderAndConnect(data, serverWs) {
  try {
    const uint8Data = new Uint8Array(data);
    
    // 1. 验证VLess UUID（协议头1-17字节）
    const uuidBytes = uint8Data.slice(1, 17);
    if (verifyVlessUUID(uuidBytes) !== verifyUUID) {
      serverWs.close(4001, "Invalid UUID");
      return null;
    }

    // 2. 解析目标地址和端口（VLess协议规范）
    const addrType = uint8Data[17]; // 地址类型：1=IPv4, 2=域名, 3=IPv6
    let targetAddr = "";
    let targetPort = 0;
    let payloadStart = 0;

    switch (addrType) {
      case 1: // IPv4
        targetAddr = uint8Data.slice(18, 22).join(".");
        targetPort = new DataView(data.slice(22, 24)).getUint16(0);
        payloadStart = 24;
        break;
      case 2: // 域名
        const domainLen = uint8Data[18];
        targetAddr = new TextDecoder().decode(uint8Data.slice(19, 19 + domainLen));
        targetPort = new DataView(data.slice(19 + domainLen, 21 + domainLen)).getUint16(0);
        payloadStart = 21 + domainLen;
        break;
      case 3: // IPv6
        const ipv6View = new DataView(data.slice(18, 34));
        const ipv6Parts = [];
        for (let i = 0; i < 8; i++) {
          ipv6Parts.push(ipv6View.getUint16(i * 2).toString(16));
        }
        targetAddr = ipv6Parts.join(":");
        targetPort = new DataView(data.slice(34, 36)).getUint16(0);
        payloadStart = 36;
        break;
      default:
        serverWs.close(4002, "Unsupported Address Type");
        return null;
    }

    // 3. 提取负载数据
    const payload = data.slice(payloadStart);

    // 4. 建立TCP连接（直连 → NAT64 → 反代）
    const tcpSocket = await createTcpConnection(targetAddr, targetPort);
    if (!tcpSocket) {
      serverWs.close(4003, "TCP Connection Failed");
      return null;
    }

    // 5. 建立TCP→WS数据管道
    await setupTcpToWsPipe(tcpSocket, serverWs, payload);

    return tcpSocket;
  } catch (error) {
    console.error("[VLess Parse Error]", error);
    serverWs.close(1011, "Parse Error");
    return null;
  }
}

/**
 * 建立TCP连接（多策略降级）
 */
async function createTcpConnection(addr, port) {
  // 策略1：直连
  try {
    const socket = connect({
      hostname: addr,
      port: port,
      allowHalfOpen: true
    });
    await socket.opened;
    console.log(`[TCP Connected] Direct -> ${addr}:${port}`);
    return socket;
  } catch (error) {
    console.log(`[Direct Failed] ${addr}:${port} - ${error.message}`);
  }

  // 策略2：NAT64（仅IPv4地址/域名）
  if (config.nat64Prefix) {
    try {
      let ipv4Addr = addr;
      // 域名解析为IPv4
      if (!/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
        ipv4Addr = await dnsResolve(addr);
      }
      const nat64Addr = convertIpv4ToNat64(ipv4Addr);
      const socket = connect({
        hostname: nat64Addr,
        port: port,
        allowHalfOpen: true
      });
      await socket.opened;
      console.log(`[TCP Connected] NAT64 -> ${nat64Addr}:${port}`);
      return socket;
    } catch (error) {
      console.log(`[NAT64 Failed] ${addr}:${port} - ${error.message}`);
    }
  }

  // 策略3：反代IP
  if (config.proxyIp) {
    try {
      const [proxyAddr, proxyPort = 443] = config.proxyIp.split(":");
      const socket = connect({
        hostname: proxyAddr,
        port: Number(proxyPort),
        allowHalfOpen: true
      });
      await socket.opened;
      console.log(`[TCP Connected] Proxy -> ${proxyAddr}:${proxyPort}`);
      return socket;
    } catch (error) {
      console.log(`[Proxy Failed] ${config.proxyIp} - ${error.message}`);
    }
  }

  return null;
}

/**
 * 建立TCP→WS数据管道
 */
async function setupTcpToWsPipe(tcpSocket, serverWs, initialPayload) {
  try {
    const tcpWriter = tcpSocket.writable.getWriter();
    // 写入初始负载
    if (initialPayload && initialPayload.byteLength > 0) {
      await tcpWriter.write(initialPayload);
    }

    // TCP数据转发到WS
    await tcpSocket.readable.pipeTo(new WritableStream({
      async write(chunk) {
        if (serverWs.readyState === WebSocket.OPEN) {
          serverWs.send(chunk);
        }
      }
    }));

    // TCP流结束后关闭WS
    if (serverWs.readyState === WebSocket.OPEN) {
      serverWs.close(1000, "TCP Stream End");
    }
  } catch (error) {
    console.error("[TCP-WS Pipe Error]", error);
    cleanupConnection(serverWs, tcpSocket);
  }
}

/**
 * 清理连接（防止内存泄漏）
 */
function cleanupConnection(ws, tcpSocket) {
  if (tcpSocket) {
    tcpSocket.close();
  }
  if (ws.readyState === WebSocket.OPEN) {
    ws.close(1001, "Connection Closed");
  }
}

// ===================== 工具函数 =====================

/**
 * 生成UUID（基于订阅路径）
 */
function generateUUID(subPath) {
  const encoder = new TextEncoder();
  const hashBytes = encoder.encode(subPath);
  // 转换为十六进制并截取20位
  const hexStr = Array.from(hashBytes)
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 20)
    .padEnd(20, "0");
  // 格式化UUID
  return `${hexStr.slice(0,8)}-0000-4000-8000-${hexStr.slice(-12)}`.toLowerCase();
}

/**
 * 加载优选节点列表
 */
async function loadPreferredList() {
  if (!config.preferredListUrl) return [];
  
  try {
    const response = await fetch(config.preferredListUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    
    const text = await response.text();
    return text.split("\n")
      .map(line => line.trim())
      .filter(line => line); // 过滤空行
  } catch (error) {
    console.error("[Load Preferred List Error]", error);
    return [];
  }
}

/**
 * IPv4转换为NAT64地址
 */
function convertIpv4ToNat64(ipv4) {
  const cleanPrefix = config.nat64Prefix.replace(/\/\d+$/, ""); // 移除前缀后的掩码
  const ipv4Parts = ipv4.split(".").map(part => (+part).toString(16).padStart(2, "0"));
  return `[${cleanPrefix}${ipv4Parts[0]}${ipv4Parts[1]}:${ipv4Parts[2]}${ipv4Parts[3]}]`;
}

/**
 * DNS解析（DOH）
 */
async function dnsResolve(domain) {
  try {
    const response = await fetch(`https://${config.dohAddress}?name=${domain}&type=A`, {
      headers: { "Accept": "application/dns-json" },
      cf: { cacheTtl: 300 } // 缓存5分钟
    });
    const data = await response.json();
    const aRecord = data.Answer?.find(ans => ans.type === 1);
    if (!aRecord) throw new Error("No A Record");
    return aRecord.data;
  } catch (error) {
    console.error("[DNS Resolve Error]", error);
    throw error;
  }
}

/**
 * 验证VLess UUID
 */
function verifyVlessUUID(uuidBytes) {
  const hexMap = Array.from({ length: 256 }, (_, i) => (i + 256).toString(16).slice(1));
  return [
    uuidBytes.slice(0,4).map(b => hexMap[b]).join(""),
    uuidBytes.slice(4,6).map(b => hexMap[b]).join(""),
    uuidBytes.slice(6,8).map(b => hexMap[b]).join(""),
    uuidBytes.slice(8,10).map(b => hexMap[b]).join(""),
    uuidBytes.slice(10,16).map(b => hexMap[b]).join("")
  ].join("-").toLowerCase();
}

// ===================== 订阅配置生成 =====================

/**
 * 处理通用订阅请求（根据UA自动匹配客户端）
 */
function handleGeneralSubRequest(request, host) {
  const userAgent = request.headers.get("User-Agent")?.toLowerCase() || "";
  const v2rayKeyword = config.keywordSplit.v2ray.join("");
  const clashKeyword = config.keywordSplit.clash.join("");

  if (userAgent.includes(v2rayKeyword)) {
    return generateV2rayConfig(host);
  } else if (userAgent.includes(clashKeyword)) {
    return generateClashConfig(host);
  } else {
    return showTipsPage();
  }
}

/**
 * 生成V2Ray配置（VLess链接）
 */
function generateV2rayConfig(host) {
  const vlessKeyword = config.keywordSplit.vless.join("");
  const nodes = processPreferredList(host);
  
  const configContent = nodes.map(node => 
    `${vlessKeyword}://${verifyUUID}@${node.addr}:${node.port}?encryption=none&security=tls&sni=${host}&fp=chrome&type=ws&host=${host}#${encodeURIComponent(node.name)}`
  ).join("\n");

  return new Response(configContent, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="v2ray-${config.subPath}.txt"`
    }
  });
}

/**
 * 生成Clash配置
 */
function generateClashConfig(host) {
  const vlessKeyword = config.keywordSplit.vless.join("");
  const nodes = processPreferredList(host);
  
  // 生成节点配置
  const proxyConfig = nodes.map(node => `  - name: ${node.name}
    type: ${vlessKeyword}
    server: ${node.addr}
    port: ${node.port}
    uuid: ${verifyUUID}
    udp: true
    tls: true
    sni: ${host}
    network: ws
    ws-opts:
      headers:
        Host: ${host}
        User-Agent: Chrome`).join("\n");

  // 生成代理组配置
  const proxyGroupItems = nodes.map(node => `    - ${node.name}`).join("\n");

  const configContent = `proxies:
${proxyConfig}

proxy-groups:
  - name: 海外规则
    type: select
    proxies:
      - 延迟优选
      - 故障转移
      - DIRECT
      - REJECT
${proxyGroupItems}
  - name: 国内规则
    type: select
    proxies:
      - DIRECT
      - 延迟优选
      - 故障转移
      - REJECT
${proxyGroupItems}
  - name: 广告屏蔽
    type: select
    proxies:
      - REJECT
      - DIRECT
      - 延迟优选
      - 故障转移
${proxyGroupItems}
  - name: 延迟优选
    type: url-test
    url: https://www.google.com/generate_204
    interval: 30
    tolerance: 50
    proxies:
${proxyGroupItems}
  - name: 故障转移
    type: fallback
    url: https://www.google.com/generate_204
    interval: 30
    proxies:
${proxyGroupItems}

rules:
  - GEOSITE,category-ads-all,广告屏蔽
  - GEOSITE,cn,国内规则
  - GEOIP,CN,国内规则,no-resolve
  - MATCH,海外规则`;

  return new Response(configContent, {
    headers: {
      "Content-Type": "text/yaml; charset=utf-8",
      "Content-Disposition": `attachment; filename="clash-${config.subPath}.yaml"`
    }
  });
}

/**
 * 生成订阅信息（Host + UUID）
 */
function generateSubInfo(host) {
  return new Response(`${host}#${verifyUUID}`, {
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}

/**
 * 提示页面
 */
function showTipsPage() {
  const v2rayKeyword = config.keywordSplit.v2ray.join("");
  const clashKeyword = config.keywordSplit.clash.join("");
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>订阅-${config.subPath}</title>
  <style>
    body {
      font-size: 25px;
      text-align: center;
      margin: 0;
      padding: 0;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f5f5f5;
    }
    .container {
      padding: 2rem;
      background: white;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
  </style>
</head>
<body>
  <div class="container">
    <strong>请将链接导入 ${clashKeyword} 或 ${v2rayKeyword} 客户端</strong>
  </div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}

/**
 * 处理优选列表（格式化节点信息）
 */
function processPreferredList(host) {
  // 插入原生节点
  const list = [`${host}#原生节点`, ...preferredList];
  
  return list.map((item, index) => {
    const [addrPort, name = `节点 ${index + 1}`] = item.split("#");
    const [addr, port = 443] = addrPort.split(":");
    return {
      addr: addr.trim(),
      port: Number(port),
      name: name.trim()
    };
  });
}