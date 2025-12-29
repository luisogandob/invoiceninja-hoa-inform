import HOAExpenseAutomation from './index.js';

/**
 * Example usage of the HOA Expense Automation system
 * This file demonstrates different ways to use the automation
 */

// Example 1: Generate report for current month
async function example1() {
  console.log('\n=== Example 1: Current Month Report ===');
  const automation = new HOAExpenseAutomation();
  
  try {
    const result = await automation.generateAndSendReport({
      period: 'current-month',
      saveToFile: true,
      outputPath: './reports/current-month-report.pdf'
    });
    console.log('Success:', result.message);
    console.log('Stats:', result.stats);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Example 2: Generate report for last month
async function example2() {
  console.log('\n=== Example 2: Last Month Report ===');
  const automation = new HOAExpenseAutomation();
  
  try {
    const result = await automation.generateAndSendReport({
      period: 'last-month',
      saveToFile: true
    });
    console.log('Success:', result.message);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Example 3: Generate report with custom date range
async function example3() {
  console.log('\n=== Example 3: Custom Date Range ===');
  const automation = new HOAExpenseAutomation();
  
  try {
    const result = await automation.generateAndSendReport({
      period: 'custom',
      customRange: {
        start: '2024-01-01',
        end: '2024-01-31'
      },
      saveToFile: true
    });
    console.log('Success:', result.message);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Example 4: Test connections only
async function example4() {
  console.log('\n=== Example 4: Test Connections ===');
  const automation = new HOAExpenseAutomation();
  
  try {
    const result = await automation.testConnections();
    console.log('Invoice Ninja:', result.invoiceNinja ? '✓' : '✗');
    console.log('Email:', result.email ? '✓' : '✗');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Example 5: Generate report and send to specific email
async function example5() {
  console.log('\n=== Example 5: Send to Specific Email ===');
  const automation = new HOAExpenseAutomation();
  
  try {
    const result = await automation.generateAndSendReport({
      period: 'current-month',
      emailTo: 'board-members@hoa.example.com',
      saveToFile: false
    });
    console.log('Success:', result.message);
  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the examples
async function runExamples() {
  // Uncomment the examples you want to run
  
  // await example1();  // Current month report
  // await example2();  // Last month report
  // await example3();  // Custom date range
  await example4();  // Test connections (safe to run without full config)
  // await example5();  // Send to specific email
}

// Execute
runExamples().catch(console.error);
