const assert = require('node:assert/strict');
const { describe, it, beforeEach, afterEach } = require('node:test');
const { T0, startServer, insert, insertEntry } = require('./helpers');

describe('crew roster', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('lists the roster sorted by name', async () => {
    for (const name of ['Rochefort', 'Île de Ré']) {
      insert(ctx.db, 'crew_members', { name, role: null, created_at: T0, updated_at: T0 });
    }
    const { body } = await ctx.request('GET', '/crew');
    assert.deepEqual(
      body.items.map((member) => member.name),
      ['Île de Ré', 'Rochefort']
    );
  });

  it('creates a crew member with or without a role', async () => {
    const noRole = await ctx.request('POST', '/crew', { name: 'Jo' });
    assert.equal(noRole.status, 201);
    assert.equal(noRole.body.name, 'Jo');
    assert.equal(noRole.body.role, null);

    const withRole = await ctx.request('POST', '/crew', { name: 'Alex Martin', role: 'skipper' });
    assert.equal(withRole.status, 201);
    assert.equal(withRole.body.role, 'skipper');
  });

  it('rejects an empty name', async () => {
    const { status } = await ctx.request('POST', '/crew', { name: '  ' });
    assert.equal(status, 400);
  });

  it('patches name and role independently', async () => {
    const created = await ctx.request('POST', '/crew', { name: 'Jo', role: 'crew' });
    const id = created.body.id;

    const renamed = await ctx.request('PATCH', `/crew/${id}`, { name: 'Jo Dupont' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'Jo Dupont');
    assert.equal(renamed.body.role, 'crew');

    const reRoled = await ctx.request('PATCH', `/crew/${id}`, { role: 'skipper' });
    assert.equal(reRoled.body.name, 'Jo Dupont');
    assert.equal(reRoled.body.role, 'skipper');
  });

  it('deletes a crew member', async () => {
    const created = await ctx.request('POST', '/crew', { name: 'Jo' });
    assert.equal((await ctx.request('DELETE', `/crew/${created.body.id}`)).status, 204);
    assert.equal((await ctx.request('DELETE', `/crew/${created.body.id}`)).status, 404);
  });

  it('deleting a crew member keeps their name and role on past passages', async () => {
    const memberId = insert(ctx.db, 'crew_members', {
      name: 'Jo',
      role: 'skipper',
      created_at: T0,
      updated_at: T0
    });
    const entryId = insertEntry(ctx.db);
    insert(ctx.db, 'log_entry_crew', {
      entry_id: entryId,
      crew_member_id: memberId,
      name: 'Jo',
      role: 'skipper',
      created_at: T0
    });

    assert.equal((await ctx.request('DELETE', `/crew/${memberId}`)).status, 204);

    const { body } = await ctx.request('GET', `/entries/${entryId}`);
    assert.equal(body.crew.length, 1);
    assert.equal(body.crew[0].crewMemberId, null);
    assert.equal(body.crew[0].name, 'Jo');
    assert.equal(body.crew[0].role, 'skipper');
  });
});

describe('entry crew', () => {
  let ctx;

  beforeEach(async () => {
    ctx = await startServer();
  });

  afterEach(() => ctx.close());

  it('has no crew by default', async () => {
    const entryId = insertEntry(ctx.db);
    const { body } = await ctx.request('GET', `/entries/${entryId}`);
    assert.deepEqual(body.crew, []);
  });

  it('assigns existing roster members and extends the roster with new names', async () => {
    const entryId = insertEntry(ctx.db);
    const memberId = insert(ctx.db, 'crew_members', {
      name: 'Alex',
      role: 'skipper',
      created_at: T0,
      updated_at: T0
    });

    const { status, body } = await ctx.request('PUT', `/entries/${entryId}/crew`, {
      members: [{ crewMemberId: memberId }, { name: 'Jo', role: 'crew' }]
    });

    assert.equal(status, 200);
    assert.equal(body.length, 2);
    assert.deepEqual(body.map((member) => member.name).sort(), ['Alex', 'Jo']);

    const roster = await ctx.request('GET', '/crew');
    assert.equal(roster.body.total, 2);
  });

  it('reuses an existing roster member by name, case- and accent-insensitively', async () => {
    const entryId = insertEntry(ctx.db);
    insert(ctx.db, 'crew_members', { name: 'Île', role: null, created_at: T0, updated_at: T0 });

    await ctx.request('PUT', `/entries/${entryId}/crew`, { members: [{ name: 'ile' }] });

    const roster = await ctx.request('GET', '/crew');
    assert.equal(roster.body.total, 1);
  });

  it('replaces rather than appends', async () => {
    const entryId = insertEntry(ctx.db);
    await ctx.request('PUT', `/entries/${entryId}/crew`, {
      members: [{ name: 'Alex' }, { name: 'Jo' }]
    });
    const second = await ctx.request('PUT', `/entries/${entryId}/crew`, {
      members: [{ name: 'Alex' }]
    });
    assert.equal(second.body.length, 1);
    assert.equal(second.body[0].name, 'Alex');
  });

  it('404s on an unknown crewMemberId', async () => {
    const entryId = insertEntry(ctx.db);
    const { status, body } = await ctx.request('PUT', `/entries/${entryId}/crew`, {
      members: [{ crewMemberId: 999 }]
    });
    assert.equal(status, 404);
    assert.equal(body.error.code, 'crew_member_not_found');
  });
});
