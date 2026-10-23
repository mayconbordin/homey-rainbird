import crypto from 'crypto';
import http from 'http';
import https from 'https';

// One ModelAndVersion request against the controller, with a hard timeout.
//
// RainBirdService.init() can't be used to validate pairing input: the library
// retries a failed request forever (60s apart), so a wrong password or an
// unreachable host never surfaces an error and pairing just hangs.

const TIMEOUT_MS = 10000;

const FALLBACK_TO_HTTP_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPROTO',
    'ERR_SSL_WRONG_VERSION_NUMBER',
    'ERR_SSL_NO_PROTOCOLS_AVAILABLE',
]);

export class ProbeError extends Error {}

const sha256 = (data: string | Buffer): Buffer => crypto.createHash('sha256').update(data).digest();

const encrypt = (password: string, body: string): Buffer => {
    const padded = Buffer.from(body, 'utf8');
    const padding = (16 - (padded.length % 16)) % 16;
    const plain = Buffer.concat([padded, Buffer.alloc(padding)]);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', sha256(Buffer.from(password, 'utf8')), iv);
    cipher.setAutoPadding(false);
    return Buffer.concat([sha256(Buffer.from(body, 'utf8')), iv, cipher.update(plain), cipher.final()]);
};

const decrypt = (password: string, data: Buffer): string => {
    const decipher = crypto.createDecipheriv('aes-256-cbc', sha256(Buffer.from(password, 'utf8')), data.subarray(32, 48));
    decipher.setAutoPadding(false);
    const plain = Buffer.concat([decipher.update(data.subarray(48)), decipher.final()]);
    // eslint-disable-next-line no-control-regex
    return plain.toString('utf8').replace(/[\x10\n\0]/g, '');
};

const post = (url: string, payload: Buffer): Promise<{ statusCode: number; body: Buffer }> => {
    const transport = url.startsWith('https:') ? https : http;
    return new Promise((resolve, reject) => {
        const req = transport.request(
            url,
            {
                method: 'POST',
                rejectUnauthorized: false,
                timeout: TIMEOUT_MS,
                headers: {
                    'Accept-Language': 'en',
                    'User-Agent': 'RainBird/2.0 CFNetwork/811.5.4 Darwin/16.7.0',
                    Accept: '*/*',
                    'Content-Type': 'application/octet-stream',
                    'Content-Length': payload.length,
                },
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
                res.on('error', reject);
            },
        );
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end(payload);
    });
};

export const probeController = async (host: string, password: string): Promise<void> => {
    const payload = encrypt(
        password,
        JSON.stringify({
            id: 9,
            jsonrpc: '2.0',
            method: 'tunnelSip',
            params: { data: '02', length: 1 }, // ModelAndVersion
        }),
    );

    let response: { statusCode: number; body: Buffer };
    try {
        try {
            response = await post(`https://${host}/stick`, payload);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            if (!FALLBACK_TO_HTTP_CODES.has(code)) {
                throw error;
            }
            response = await post(`http://${host}/stick`, payload);
        }
    } catch (error) {
        const err = error as NodeJS.ErrnoException;
        throw new ProbeError(`Could not reach the controller at ${host} (${err.code ?? err.message})`);
    }

    if (response.statusCode === 403) {
        throw new ProbeError('The controller rejected the password (HTTP 403 "Invalid Password")');
    }
    if (response.statusCode !== 200) {
        throw new ProbeError(`Unexpected response from the controller (HTTP ${response.statusCode})`);
    }

    let result: { error?: { code: number; message: string } };
    try {
        result = JSON.parse(decrypt(password, response.body));
    } catch (error) {
        throw new ProbeError('Could not decrypt the controller response, the password is probably wrong');
    }
    if (result.error) {
        throw new ProbeError(`Controller returned error ${result.error.code}: ${result.error.message}`);
    }
};
