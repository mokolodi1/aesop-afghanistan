const { getPool, isDatabaseEnabled } = require('../db');

function assertDatabase() {
  const pool = getPool();
  if (!isDatabaseEnabled() || !pool) throw new Error('Ticket system requires the database.');
  return pool;
}

function isOperationsTeam(profile, isAdmin = false) {
  if (isAdmin) return true;
  return String(profile?.adminRole || '').trim().toLowerCase() === 'operations team';
}

async function getPersonForProfile(profile) {
  const result = await assertDatabase().query(
    `SELECT id, aesop_id, email, name, portal_role, admin_role FROM people
     WHERE lower(btrim(aesop_id)) = lower(btrim($1))
       AND lower(btrim(email)) = lower(btrim($2)) LIMIT 1`,
    [profile.id, profile.email],
  );
  return result.rows[0] || null;
}

function ticketDto(row, operationsView = false) {
  const dto = {
    id: row.id, subject: row.subject, category: row.category || '', status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, lastMessageAt: row.last_message_at,
  };
  if (operationsView) {
    dto.studentAesopId = row.creator_aesop_id;
    dto.studentName = row.creator_name || '';
    dto.studentEmail = row.creator_email;
    dto.assignedToPersonId = row.assigned_to_person_id || null;
  }
  return dto;
}

function messageDto(row, operationsView = false) {
  const dto = {
    id: row.id, message: row.body, createdAt: row.created_at,
    authorType: row.author_display_role === 'operations_team' ? 'operations' : 'student',
    authorLabel: row.author_display_role === 'operations_team' ? 'Operations Team' : 'Student',
  };
  if (operationsView) {
    dto.createdByPersonId = row.author_person_id;
    dto.createdByAesopId = row.author_aesop_id;
    dto.createdByName = row.author_name || '';
    dto.createdByEmail = row.author_email;
  }
  return dto;
}

const SELECT_TICKET = `SELECT t.*, p.aesop_id creator_aesop_id, p.name creator_name, p.email creator_email
  FROM tickets t JOIN people p ON p.id=t.creator_person_id`;

async function createTicket(person, { subject, category, message }) {
  const client = await assertDatabase().connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      `INSERT INTO tickets (creator_person_id,subject,category) VALUES ($1,$2,$3) RETURNING *`,
      [person.id, subject, category || null],
    );
    const ticket = created.rows[0];
    await client.query(`INSERT INTO ticket_messages (ticket_id,author_person_id,author_display_role,body) VALUES ($1,$2,'student',$3)`, [ticket.id, person.id, message]);
    await client.query('COMMIT');
    return ticketDto({ ...ticket, creator_aesop_id: person.aesop_id, creator_name: person.name, creator_email: person.email });
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function listStudentTickets(person) {
  const result = await assertDatabase().query(`${SELECT_TICKET} WHERE t.creator_person_id=$1 ORDER BY t.last_message_at DESC`, [person.id]);
  return result.rows.map((r) => ticketDto(r));
}

async function getTicket(ticketId, person, operationsView) {
  const params = [ticketId];
  let access = '';
  if (!operationsView) { params.push(person.id); access = ' AND t.creator_person_id=$2'; }
  const result = await assertDatabase().query(`${SELECT_TICKET} WHERE t.id=$1${access}`, params);
  if (!result.rows[0]) return null;
  const messages = await assertDatabase().query(
    `SELECT m.*, p.aesop_id author_aesop_id, p.name author_name, p.email author_email
     FROM ticket_messages m JOIN people p ON p.id=m.author_person_id WHERE m.ticket_id=$1 ORDER BY m.created_at,m.id`, [ticketId]);
  return { ...ticketDto(result.rows[0], operationsView), messages: messages.rows.map((r) => messageDto(r, operationsView)) };
}

async function listOperationsTickets(status) {
  const params = []; let where = '';
  if (status) { params.push(status); where = ' WHERE t.status=$1'; }
  const result = await assertDatabase().query(`${SELECT_TICKET}${where} ORDER BY t.last_message_at DESC`, params);
  return result.rows.map((r) => ticketDto(r, true));
}

async function addReply(ticketId, person, body, operationsView) {
  const client = await assertDatabase().connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(`${SELECT_TICKET} WHERE t.id=$1${operationsView ? '' : ' AND t.creator_person_id=$2'} FOR UPDATE`, operationsView ? [ticketId] : [ticketId, person.id]);
    if (!found.rows[0]) { await client.query('ROLLBACK'); return null; }
    const role = operationsView ? 'operations_team' : 'student';
    await client.query(`INSERT INTO ticket_messages (ticket_id,author_person_id,author_display_role,body) VALUES ($1,$2,$3,$4)`, [ticketId, person.id, role, body]);
    const status = operationsView ? 'waiting' : 'open';
    await client.query(`UPDATE tickets SET updated_at=NOW(),last_message_at=NOW(),status=$2,resolved_at=NULL WHERE id=$1`, [ticketId, status]);
    await client.query('COMMIT');
    return ticketDto({ ...found.rows[0], status, updated_at: new Date(), last_message_at: new Date() }, operationsView);
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

async function updateStatus(ticketId, status, person) {
  const result = await assertDatabase().query(
    `UPDATE tickets SET status=$2,updated_at=NOW(),resolved_at=CASE WHEN $2='resolved' THEN NOW() ELSE NULL END,
     assigned_to_person_id=COALESCE(assigned_to_person_id,$3) WHERE id=$1 RETURNING *`, [ticketId, status, person.id]);
  return result.rows[0] || null;
}

module.exports = { isOperationsTeam, getPersonForProfile, createTicket, listStudentTickets, getTicket, listOperationsTickets, addReply, updateStatus };
