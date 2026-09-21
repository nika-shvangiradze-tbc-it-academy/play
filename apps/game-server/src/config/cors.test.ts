import { describe, expect, it } from 'vitest';
import express from 'express';
import cors from 'cors';
import { createCorsOptions, parseCorsOrigins } from '../config/cors.js';

describe('parseCorsOrigins', () => {
  it('defaults to localhost when unset or empty', () => {
    expect(parseCorsOrigins(undefined)).toEqual(['http://localhost:4200']);
    expect(parseCorsOrigins('')).toEqual(['http://localhost:4200']);
    expect(parseCorsOrigins('  ,  ')).toEqual(['http://localhost:4200']);
  });

  it('parses comma-separated origins and trims whitespace', () => {
    expect(
      parseCorsOrigins('https://gartoba.netlify.app, http://localhost:4200'),
    ).toEqual(['https://gartoba.netlify.app', 'http://localhost:4200']);
  });
});

describe('CORS preflight for Netlify origin', () => {
  it('returns Access-Control-Allow-Origin for OPTIONS /api/rooms', async () => {
    const app = express();
    app.use(
      cors(
        createCorsOptions([
          'https://gartoba.netlify.app',
          'http://localhost:4200',
        ]),
      ),
    );
    app.post('/api/rooms', (_req, res) => {
      res.status(201).json({ ok: true });
    });

    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP address');
      }
      const res = await fetch(`http://127.0.0.1:${address.port}/api/rooms`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://gartoba.netlify.app',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type,authorization',
        },
      });

      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'https://gartoba.netlify.app',
      );
      expect(res.headers.get('access-control-allow-credentials')).toBe('true');
      const allowHeaders = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase();
      expect(allowHeaders).toContain('authorization');
      expect(allowHeaders).toContain('content-type');
      const allowMethods = (res.headers.get('access-control-allow-methods') ?? '').toUpperCase();
      expect(allowMethods).toContain('POST');
      expect(allowMethods).toContain('OPTIONS');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it('does not reflect disallowed origins', async () => {
    const app = express();
    app.use(cors(createCorsOptions(['https://gartoba.netlify.app'])));
    app.get('/api/health', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('expected TCP address');
      }
      const res = await fetch(`http://127.0.0.1:${address.port}/api/health`, {
        method: 'GET',
        headers: { Origin: 'https://evil.example' },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
