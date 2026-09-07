import { describe, it, expect } from 'vitest';
import { extractEdgeFunctionErrorMessage } from '@/utils/edgeFunctionError';

describe('extractEdgeFunctionErrorMessage', () => {
  it('extracts the real message from a FunctionsHttpError-shaped error context', async () => {
    const context = new Response(JSON.stringify({ error: 'File is too large (max 3MB)' }), { status: 400 });
    const message = await extractEdgeFunctionErrorMessage({
      message: 'Edge Function returned a non-2xx status code',
      context,
    });
    expect(message).toBe('File is too large (max 3MB)');
  });

  it('falls back to the generic message when the context body has no `error` field', async () => {
    const context = new Response(JSON.stringify({ something: 'else' }), { status: 400 });
    const message = await extractEdgeFunctionErrorMessage({
      message: 'Edge Function returned a non-2xx status code',
      context,
    });
    expect(message).toBe('Edge Function returned a non-2xx status code');
  });

  it('falls back to the generic message when the context body is not JSON', async () => {
    const context = new Response('not json', { status: 500 });
    const message = await extractEdgeFunctionErrorMessage({
      message: 'Edge Function returned a non-2xx status code',
      context,
    });
    expect(message).toBe('Edge Function returned a non-2xx status code');
  });

  it('falls back to the generic message when there is no context at all (e.g. a network error)', async () => {
    const message = await extractEdgeFunctionErrorMessage({ message: 'Failed to send a request to the Edge Function' });
    expect(message).toBe('Failed to send a request to the Edge Function');
  });

  it('does not throw if the context has already been consumed', async () => {
    const context = new Response(JSON.stringify({ error: 'real reason' }), { status: 400 });
    await context.json(); // consume the body before extraction gets a chance to
    const message = await extractEdgeFunctionErrorMessage({
      message: 'Edge Function returned a non-2xx status code',
      context,
    });
    expect(message).toBe('Edge Function returned a non-2xx status code');
  });
});
