import axios from 'axios';
import crypto from 'crypto';
import { Client } from 'pg';

/**
 * Fill these in
 */
// Enter the api key for the Application you created in Supaglue Cloud. We will migrate connections to the corresponding Application.
const apiKey = '...';

// Run this command to get the secret you are using in your self-hosted K8s Supaglue instance to encrypt/decrypt connection credentials
// echo $(kubectl -n supaglue get secret -o json supaglue-secret | jq '.data."db-encryption-secret"' -r | base64 -d)
const secret = '...';

// Run this command to get the password you are using in your self-hosted K8s Supaglue instance to connect to Postgres
// echo $(kubectl get secrets supaglue-postgresql -n supaglue -o jsonpath='{.data.password}' | base64 -d)
const pgPassword = '...';


/**
 * Do not touch anything beyond this
 */
const pgDatabase = 'supaglue'; // docker: postgres
const pgSchema = 'public'; // docker: api
const pgUser = 'supaglue'; // docker: postgres
const pgPort = 5432; // 5432
// const pgPassword = 'supaglue'; // (on docker)


const apiUrl = 'https://api.supaglue.io';

/**
 * Do not modify
 */
async function listConnections(): Promise<{ id: string, provider_name: string, customer_id: string, credentials: string }[]> {
  const client = new Client({
    host: 'localhost',
    port: pgPort,
    database: pgDatabase,
    user: pgUser,
    password: pgPassword,
  });
  await client.connect();

  const res = await client.query(`select id, provider_name, customer_id, encode(credentials, 'hex') as credentials from ${pgSchema}.connections`);
  const rows = res.rows;

  await client.end();
  
  return rows;
}

const algorithm = 'aes-256-cbc';
const saltLength = 16;
const ivLength = 16;

async function getKey(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(secret, salt, 100000, 32, 'sha512', (err, key) => {
      if (err) {
        return reject(err);
      }

      resolve(key);
    });
  });
}

async function decrypt(buffer: Buffer): Promise<Credentials> {
  const salt = buffer.subarray(0, saltLength);
  const iv = buffer.subarray(saltLength, saltLength + ivLength);
  const encryptedData = buffer.subarray(saltLength + ivLength);
  if (!secret) {
    throw new Error('Cannot decrypt without a secret');
  }
  const key = await getKey(secret, salt);

  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(key), iv);
  const decryptedString = Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString();
  return JSON.parse(decryptedString);
}

type Credentials = {
  refreshToken: string;
};

type Integration = {
  id: string;
  provider_name: 'hubspot' | 'salesforce';
};

async function listIntegrations(): Promise<Integration[]> {
  const response = await axios.get(`${apiUrl}/mgmt/v1/integrations`, {
    headers: {
      'x-api-key': apiKey,
    },
  });

  return response.data;
}

async function getHubspotIntegrationId(): Promise<string> {
  const integrations = await listIntegrations();
  const hubspotIntegration = integrations.find((integration) => integration.provider_name === 'hubspot');
  if (!hubspotIntegration) {
    throw new Error('Hubspot integration not found on Supaglue Cloud. Please create one first.');
  }
  return hubspotIntegration.id;
}

type ConnectionCreateParams = {
  integration_id: string;
  credentials: {
    type: 'oauth2';
    refresh_token: string;
  }
};

async function createHubspotConnection(customerId: string, params: ConnectionCreateParams): Promise<void> {
  const response = await axios.post(`${apiUrl}/mgmt/v1/customers/${customerId}/connections`, params, {
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
  });
}

async function getConnectionById(connectionId: string): Promise<{ id: string, provider_name: string, customer_id: string, credentials: string }> {
  const connections = await listConnections();
  const connection = connections.find((connection) => connection.id === connectionId);
  if (!connection) {
    throw new Error('Connection not found');
  }
  return connection;
}

async function migrateAll(): Promise<void> {
  const connections = await listConnections();
  for (const connection of connections) {
    await migrateSingle(connection.id);
  }
}

async function migrateSingle(connectionId: string): Promise<void> {
  console.log(`---------- Migrating connection ${connectionId} ----------`);
  const connection = await getConnectionById(connectionId);
  const customerId = connection.customer_id.split(':')[1];
  console.log(`Connection belongs to customer ${customerId}`);

  if (connection.provider_name !== 'hubspot') {
    throw new Error('Connection is not a Hubspot connection');
  }

  console.log('Decrypting credentials...');
  const decrypted = await decrypt(Buffer.from(connection.credentials, 'hex'));
  console.log('Decrypted credentials!');

  console.log('Fetching hubspot integration from Cloud...');
  const hubspotIntegrationId = await getHubspotIntegrationId();
  console.log('Found hubspot integration in Cloud!');

  console.log('Creating connection on Cloud...');
  await createHubspotConnection(customerId, {
    integration_id: hubspotIntegrationId,
    credentials: {
      type: 'oauth2',
      refresh_token: decrypted.refreshToken,
    },
  });
  console.log('Connection created on Cloud!');
  console.log();
}

// Begin
const args = process.argv.slice(2);

if (args[0] === 'list-connections') {
  (async () => {
    const connections = await listConnections();
    for (const connection of connections) {
      console.log(`id: ${connection.id}, provider_name: ${connection.provider_name}, customer_id: ${connection.customer_id}`);
    }
  })();
} else if (args[0] === 'migrate-all') {
  (async () => {
    await migrateAll();
  })();
} else if (args[0] === 'migrate-single') {
  if (!args[1]) {
    console.error('Please provide a connection id');
    process.exit(1);
  }
  (async () => {
    await migrateSingle(args[1]);
  })();
}