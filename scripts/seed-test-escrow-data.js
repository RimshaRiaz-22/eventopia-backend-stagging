require('dotenv').config();

const db = require('../src/db');
const bcrypt = require('bcryptjs');

/**
 * Seed test data for escrow system
 * Creates: Territory, Promoter, Event, Ticket Types, Orders, Tickets, Escrow Accounts & Liabilities
 */
async function seedTestEscrowData() {
  try {
    console.log('🌱 Starting test data seeding...\n');

    // ============ 1. CREATE TERRITORY ============
    console.log('📍 Creating territory...');
    
    const territoryResult = await db.query(`
      INSERT INTO territories (name, country, is_active)
      VALUES ($1, $2, $3)
      ON CONFLICT (name) DO UPDATE SET updated_at = NOW()
      RETURNING id, name;
    `, ['London Test', 'UK', true]);
    
    const territoryId = territoryResult.rows[0].id;
    console.log(`✅ Territory created: ${territoryResult.rows[0].name} (ID: ${territoryId})\n`);

    // ============ 2. CREATE PROMOTER USER ============
    console.log('👤 Creating promoter user...');
    const promoterEmail = 'promoter-test@escrow.local';
    const passwordHash = await bcrypt.hash('password123', 10);
    
    const userResult = await db.query(`
      INSERT INTO users (email, password_hash, name, role, email_status, account_status)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
      RETURNING id, email, name, role;
    `, [promoterEmail, passwordHash, 'Test Promoter', 'promoter', 'verified', 'active']);
    
    const promoterId = userResult.rows[0].id;
    console.log(`✅ Promoter user created: ${userResult.rows[0].name} (ID: ${promoterId})\n`);

    // ============ 3. CREATE PROMOTER PROFILE ============
    console.log('📋 Creating promoter profile...');
    const profileResult = await db.query(`
      INSERT INTO promoter_profiles (user_id, territory_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, user_id, territory_id;
    `, [promoterId, territoryId]);
    
    const promoterProfileId = profileResult.rows[0].id;
    console.log(`✅ Promoter profile created (ID: ${promoterProfileId})\n`);

    // ============ 4. CREATE ESCROW ACCOUNT ============
    console.log('💰 Creating escrow account...');
    const escrowResult = await db.query(`
      INSERT INTO escrow_accounts (territory_id, balance, interest_earned)
      VALUES ($1, $2, $3)
      ON CONFLICT (territory_id) DO UPDATE SET updated_at = NOW()
      RETURNING id, territory_id, balance, interest_earned;
    `, [territoryId, 1000000, 2917]); // £10,000.00 balance, £29.17 interest
    
    const escrowAccountId = escrowResult.rows[0].id;
    console.log(`✅ Escrow account created (ID: ${escrowAccountId}, Balance: £${escrowResult.rows[0].balance / 100})\n`);

    // ============ 5. CREATE EVENT ============
    console.log('🎉 Creating event...');
    const eventStartDate = new Date();
    eventStartDate.setDate(eventStartDate.getDate() + 7); // 7 days from now
    
    const eventEndDate = new Date(eventStartDate);
    eventEndDate.setHours(eventEndDate.getHours() + 3);

    const eventResult = await db.query(`
      INSERT INTO events (
        promoter_id, territory_id, title, description,
        start_at, end_at, timezone, city,
        format, access_mode, visibility, status,
        tickets_sold
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      RETURNING id, title, start_at, status, tickets_sold;
    `, [
      promoterId,
      territoryId,
      'Test Event - Escrow Demo',
      'This is a test event for escrow system demonstration',
      eventStartDate.toISOString(),
      eventEndDate.toISOString(),
      'Europe/London',
      'London',
      'in_person',
      'ticketed',
      'public',
      'published',
      0
    ]);
    
    const eventId = eventResult.rows[0].id;
    console.log(`✅ Event created: "${eventResult.rows[0].title}" (ID: ${eventId})\n`);

    // ============ 6. CREATE TICKET TYPES ============
    console.log('🎫 Creating ticket types...');
    const ticketTypeIds = [];
    
    const ticketConfigs = [
      { name: 'General Admission', price: 10000, quantity: 50 }, // £100.00
      { name: 'VIP', price: 25000, quantity: 20 },                // £250.00
    ];

    for (const config of ticketConfigs) {
      const typeResult = await db.query(`
        INSERT INTO ticket_types (event_id, name, currency, price_amount, booking_fee_amount, capacity_total)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id, name, price_amount;
      `, [
        eventId,
        config.name,
        'GBP',
        config.price,
        100, // £1.00 booking fee
        config.quantity
      ]);
      
      ticketTypeIds.push(typeResult.rows[0].id);
      console.log(`  ✅ ${config.name}: £${config.price / 100} (Capacity: ${config.quantity})`);
    }
    console.log();

    // ============ 7. CREATE BUYER USER FOR ORDERS ============
    console.log('🛒 Creating buyer user...');
    const buyerEmail = 'buyer-test@escrow.local';
    
    const buyerResult = await db.query(`
      INSERT INTO users (email, password_hash, name, role, email_status, account_status)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
      RETURNING id, email, name;
    `, [buyerEmail, passwordHash, 'Test Buyer', 'buyer', 'verified', 'active']);
    
    const buyerId = buyerResult.rows[0].id;
    console.log(`✅ Buyer user created: ${buyerResult.rows[0].name} (ID: ${buyerId})\n`);

    // ============ 8. CREATE ORDERS & ORDER ITEMS ============
    console.log('📦 Creating orders and tickets...');
    
    // Create 3 orders with different ticket combinations
    const orderConfigs = [
      { name: 'Order 1', itemsPerType: [5, 2] }, // 5 General + 2 VIP
      { name: 'Order 2', itemsPerType: [10, 0] }, // 10 General only
      { name: 'Order 3', itemsPerType: [3, 5] }, // 3 General + 5 VIP
    ];

    let totalTicketsSold = 0;
    let totalGrossRevenue = 0;

    for (const orderConfig of orderConfigs) {
      const orderNumber = `ORD-${Date.now()}-${Math.random().toString(36).substr(2, 9).toUpperCase()}`;
      
      let subtotalAmount = 0;
      let bookingFeeAmount = 0;

      // Calculate totals for this order
      for (let i = 0; i < ticketTypeIds.length; i++) {
        const qty = orderConfig.itemsPerType[i];
        if (qty > 0) {
          const config = ticketConfigs[i];
          subtotalAmount += config.price * qty;
          bookingFeeAmount += 100 * qty; // £1 per ticket
        }
      }

      const totalAmount = subtotalAmount + bookingFeeAmount;

      // Insert order
      const orderResult = await db.query(`
        INSERT INTO orders (
          order_number, buyer_user_id, event_id,
          subtotal_amount, booking_fee_amount, total_amount,
          currency, status, payment_status, confirmed_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
        RETURNING id, order_number, total_amount;
      `, [
        orderNumber,
        buyerId,
        eventId,
        subtotalAmount,
        bookingFeeAmount,
        totalAmount,
        'GBP',
        'completed',
        'paid',
      ]);

      const orderId = orderResult.rows[0].id;
      let orderTickets = 0;

      // Insert order items and tickets
      for (let i = 0; i < ticketTypeIds.length; i++) {
        const qty = orderConfig.itemsPerType[i];
        if (qty > 0) {
          const ticketTypeId = ticketTypeIds[i];
          const config = ticketConfigs[i];
          const subtotal = config.price * qty;

          // Insert order item
          const itemResult = await db.query(`
            INSERT INTO order_items (
              order_id, ticket_type_id, ticket_name,
              ticket_price_amount, ticket_booking_fee_amount, quantity, subtotal_amount,
              buyer_name, buyer_email
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            RETURNING id;
          `, [
            orderId,
            ticketTypeId,
            config.name,
            config.price,
            100,
            qty,
            subtotal,
            buyerResult.rows[0].name,
            buyerEmail
          ]);

          const orderItemId = itemResult.rows[0].id;

          // Insert individual tickets
          for (let j = 0; j < qty; j++) {
            const randomSuffix = Math.random().toString(36).substr(2, 9).toUpperCase();
            const ticketCode = `TKT-${eventId}-${Date.now()}-${randomSuffix}-${j}`;
            await db.query(`
              INSERT INTO tickets (
                order_item_id, event_id, ticket_type_id,
                ticket_code, buyer_name, buyer_email,
                status, created_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
            `, [
              orderItemId,
              eventId,
              ticketTypeId,
              ticketCode,
              buyerResult.rows[0].name,
              buyerEmail,
              'ACTIVE'
            ]);
            
            orderTickets++;
          }
        }
      }

      totalTicketsSold += orderTickets;
      totalGrossRevenue += subtotalAmount;

      console.log(`  ✅ ${orderConfig.name}: ${orderTickets} tickets, £${subtotalAmount / 100}`);
    }
    console.log();

    // ============ 9. UPDATE EVENT TICKETS SOLD ============
    console.log('🔄 Updating event ticket count...');
    await db.query(`
      UPDATE events SET tickets_sold = $1 WHERE id = $2;
    `, [totalTicketsSold, eventId]);
    console.log(`✅ Event updated: ${totalTicketsSold} tickets sold\n`);

    // ============ 10. CREATE ESCROW LIABILITY ============
    console.log('📊 Creating escrow liability...');
    console.log(`   Territory ID: ${territoryId}, Promoter Profile ID: ${promoterProfileId}, Event ID: ${eventId}, Revenue: £${(totalGrossRevenue / 100).toFixed(2)}`);
    
    let liabilityResult = null;
    try {
      liabilityResult = await db.query(`
        INSERT INTO escrow_liabilities (
          territory_id, promoter_id, event_id,
          gross_ticket_revenue, refund_deductions, status
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING liability_id, gross_ticket_revenue, net_liability, status;
      `, [
        territoryId,
        promoterProfileId,
        eventId,
        totalGrossRevenue, // Total in pence
        0, // No refunds yet
        'HOLDING'
      ]);
      
      console.log(`✅ Escrow liability created:`);
      console.log(`   Gross Revenue: £${liabilityResult.rows[0].gross_ticket_revenue / 100}`);
      console.log(`   Refunds: £${0}`);
      console.log(`   Net Held: £${liabilityResult.rows[0].net_liability / 100}`);
      console.log(`   Status: ${liabilityResult.rows[0].status}\n`);
    } catch (err) {
      if (err.message.includes('does not exist')) {
        console.log('⚠️  Escrow_liabilities table not found - skipping\n');
      } else {
        console.error('❌ Escrow liability creation failed:');
        console.error(`   Error: ${err.message}`);
        console.error(`   Code: ${err.code}`);
        console.error(`   Detail: ${err.detail}\n`);
      }
    }

    // ============ 11. ADD INTEREST ENTRY ============
    console.log('📈 Adding sample interest entry...');
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    await db.query(`
      INSERT INTO escrow_interest_log (
        territory_id, period_start, period_end,
        opening_balance, interest_rate, interest_amount, source
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [
      territoryId,
      monthStart.toISOString().split('T')[0],
      monthEnd.toISOString().split('T')[0],
      1000000, // £10,000 in pence
      0.035000, // 3.5% annual = 0.29% monthly
      2917, // £29.17 in pence
      'bank_statement'
    ]).catch(err => {
      if (err.message.includes('does not exist')) {
        console.log('⚠️  Escrow_interest_log table not found - skipping\n');
        return null;
      }
      throw err;
    });

    console.log(`✅ Interest entry created: £29.17 for ${monthStart.toISOString().split('T')[0]}\n`);

    // ============ SUMMARY ============
    console.log('\n' + '='.repeat(60));
    console.log('✅ TEST DATA SEEDING COMPLETE!');
    console.log('='.repeat(60));
    console.log('\n📊 CREATED DATA SUMMARY:');
    console.log(`   Territory: London (ID: ${territoryId})`);
    console.log(`   Promoter: Test Promoter (ID: ${promoterId})`);
    console.log(`   Event: Test Event - Escrow Demo (ID: ${eventId})`);
    console.log(`   Ticket Types: ${ticketTypeIds.length}`);
    console.log(`   Total Tickets Sold: ${totalTicketsSold}`);
    console.log(`   Gross Revenue: £${(totalGrossRevenue / 100).toFixed(2)}`);
    console.log(`   Escrow Balance: £${((1000000 + 2917) / 100).toFixed(2)}`);
    console.log(`   Escrow Liability: £${(totalGrossRevenue / 100).toFixed(2)}`);
    const coverageRatio = (1000000 + 2917) / totalGrossRevenue;
    console.log(`   Coverage Ratio: ${coverageRatio.toFixed(2)}`);
    console.log('\n🔑 TEST CREDENTIALS:');
    console.log(`   Promoter Email: ${promoterEmail}`);
    console.log(`   Promoter ID: ${promoterId}`);
    console.log(`   Password: password123`);
    console.log(`   Territory ID: ${territoryId}`);
    console.log('\n🌐 API ENDPOINTS TO TEST:');
    console.log(`   Coverage Ratio: GET /api/v1/escrow/coverage/${territoryId}`);
    console.log(`   Promoter Escrow: GET /api/v1/escrow/promoter/finance/escrow`);
    console.log(`   Promoter Escrow (Filter): GET /api/v1/escrow/promoter/finance/escrow?promoter_id=${promoterId}`);
    console.log(`   Interest History: GET /api/v1/escrow/interest/${territoryId}`);
    console.log('\n📝 POSTMAN TEST STEPS:');
    console.log(`   1. Login with ${promoterEmail} / password123 to get token`);
    console.log(`   2. Use token in Authorization header for all escrow API calls`);
    console.log(`   3. Test each endpoint above`);
    console.log('\n' + '='.repeat(60) + '\n');

    await db.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding data:', error.message);
    console.error(error);
    await db.end();
    process.exit(1);
  }
}

// Run the seed function
seedTestEscrowData();
