import { PolymarketClient } from '../clients/polymarket.client';
import * as dotenv from 'dotenv';

dotenv.config();

async function testTrade() {
  const privateKey = process.env.PRIVATE_KEY;
  const address = process.env.FUNDER_ADDRESS;

  if (!privateKey || !address) {
    console.error('Error: Set PRIVATE_KEY and FUNDER_ADDRESS in .env');
    process.exit(1);
  }

  const client = new PolymarketClient({
    privateKey,
    funderAddress: address,
  });

  console.log('Testing trade execution...\n');

  // Initialize credentials
  console.log('1. Initializing credentials...');
  await client.deriveApiCredentials();
  console.log('   ✓ Credentials ready\n');

  // Market: "Will Trump deport 250,000-500,000 people?" - Yes token
  // This is a high-probability market (~89%) so we're buying something likely to resolve Yes
  const tokenId = '13244681086321087932946246027856416106585284024824496763706748621681543444582';
  const amount = 1; // $1 test (market min may be higher)
  const side = 'BUY';

  console.log('2. Placing test order...');
  console.log(`   Market: Will Trump deport 250,000-500,000 people?`);
  console.log(`   Side: ${side}`);
  console.log(`   Amount: $${amount}`);
  console.log(`   Token: Yes\n`);

  try {
    const result = await client.placeMarketOrder({
      tokenId,
      amount,
      side,
    });

    if (result.success) {
      console.log('✓ Order placed successfully!');
      console.log(`  Order ID: ${result.orderId}`);
    } else {
      console.log('✗ Order failed:', result.errorMessage);
    }
  } catch (error: any) {
    console.error('✗ Order error:', error.message || error);
  }
}

testTrade().catch(console.error);
