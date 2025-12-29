# Quick Start Guide

Get up and running with Invoice Ninja HOA Expense Automation in 5 minutes!

## Prerequisites

- Node.js 18 or higher
- Self-hosted Invoice Ninja instance
- Email account with SMTP access (Gmail, Outlook, etc.)

## Step 1: Installation

```bash
# Clone the repository
git clone https://github.com/luisogandob/invoiceninja-hoa-inform.git
cd invoiceninja-hoa-inform

# Install dependencies
npm install
```

## Step 2: Configuration

Create a `.env` file:

```bash
cp .env.example .env
```

Edit `.env` and fill in your details:

### Invoice Ninja Settings

1. Log in to your Invoice Ninja instance
2. Go to Settings → Account Management → API Tokens
3. Create a new token
4. Copy the URL and token to `.env`:

```env
INVOICE_NINJA_URL=https://your-invoice-ninja.com
INVOICE_NINJA_TOKEN=your-token-here
```

### Email Settings (Gmail Example)

```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_FROM=hoa@yourdomain.com
EMAIL_TO=recipients@yourdomain.com
```

**Note**: For Gmail, you need to:
1. Enable 2-factor authentication
2. Generate an "App Password" in your Google Account settings
3. Use the app password instead of your regular password

### Report Settings

```env
REPORT_TITLE=HOA Expense Report
REPORT_PERIOD=monthly
```

## Step 3: Test Configuration

```bash
npm start test
```

You should see:
```
✓ Invoice Ninja API connected
✓ Email connection verified
```

## Step 4: Generate Your First Report

```bash
npm start report last-month
```

This will:
1. Fetch expenses from Invoice Ninja
2. Generate a PDF report
3. Email it to configured recipients
4. Save a copy locally as `expense-report.pdf`

## Common Commands

```bash
# Test connections
npm start test

# Current month report
npm start report current-month

# Last month report
npm start report last-month

# Year-to-date report
npm start report current-year

# Previous year report
npm start report last-year
```

## Next Steps

### Automate Monthly Reports

**Option 1: Cron Job (Linux/Mac)**

```bash
# Edit crontab
crontab -e

# Add this line (runs on 1st of month at 9 AM)
0 9 1 * * cd /path/to/invoiceninja-hoa-inform && npm start report last-month
```

**Option 2: Task Scheduler (Windows)**

1. Open Task Scheduler
2. Create Basic Task
3. Set trigger: Monthly, day 1, 9:00 AM
4. Action: Start a program
5. Program: `node`
6. Arguments: `src/index.js report last-month`
7. Start in: `C:\path\to\invoiceninja-hoa-inform`

**Option 3: GitHub Actions**

The repository includes `.github/workflows/monthly-report.yml`. To use it:

1. Go to your repository settings → Secrets
2. Add all environment variables as secrets:
   - `INVOICE_NINJA_URL`
   - `INVOICE_NINJA_TOKEN`
   - `EMAIL_HOST`
   - `EMAIL_USER`
   - `EMAIL_PASSWORD`
   - etc.
3. The workflow will run automatically on the 1st of each month

### Customize PDF Reports

Edit `src/lib/pdfGenerator.js` to customize:
- Colors and styling
- Table columns
- Header/footer content
- Page layout

### Customize Email Content

Edit `src/index.js` methods:
- `generateEmailText()` - Plain text version
- `generateEmailHtml()` - HTML version

## Troubleshooting

### "Invoice Ninja API connected" fails

- Verify URL is correct and accessible
- Check API token is valid
- Ensure token has proper permissions

### "Email connection verified" fails

- Verify SMTP settings
- Check username/password
- For Gmail, ensure you're using an app password
- Check firewall/network restrictions

### "No expenses found"

- Verify expenses exist in Invoice Ninja for the period
- Check expense dates are correct
- Try with a different period

### PDF Generation Issues

- Ensure all dependencies installed correctly
- Check system has enough memory
- Try regenerating the report

## Getting Help

- Check the full [README.md](README.md) for detailed documentation
- Open an issue on GitHub for bugs or questions
- See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines

## Security Notes

- Never commit `.env` file to version control
- Keep API tokens secure
- Use app-specific passwords for email
- Regularly rotate credentials
- Review email recipient list regularly

Happy automating! 🚀
