import axios from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

/**
 * Invoice Ninja API Client
 * Handles communication with self-hosted Invoice Ninja instance
 */
class InvoiceNinjaClient {
  constructor() {
    this.baseURL = process.env.INVOICE_NINJA_URL;
    this.token = process.env.INVOICE_NINJA_TOKEN;
    
    if (!this.baseURL || !this.token) {
      throw new Error('Invoice Ninja configuration missing. Please set INVOICE_NINJA_URL and INVOICE_NINJA_TOKEN in .env file');
    }

    this.client = axios.create({
      baseURL: `${this.baseURL}/api/v1`,
      headers: {
        'X-Api-Token': this.token,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
  }

  /**
   * Get all expenses with optional filters
   * @param {Object} filters - Query parameters for filtering
   * @returns {Promise<Array>} Array of expenses
   */
  async getExpenses(filters = {}) {
    try {
      const response = await this.client.get('/expenses', { params: filters });
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching expenses:', error.message);
      throw error;
    }
  }

  /**
   * Get a single expense by ID
   * @param {string} expenseId - The expense ID
   * @returns {Promise<Object>} Expense object
   */
  async getExpense(expenseId) {
    try {
      const response = await this.client.get(`/expenses/${expenseId}`);
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching expense ${expenseId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get all clients
   * @returns {Promise<Array>} Array of clients
   */
  async getClients() {
    try {
      const response = await this.client.get('/clients');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching clients:', error.message);
      throw error;
    }
  }

  /**
   * Get all vendors
   * @returns {Promise<Array>} Array of vendors
   */
  async getVendors() {
    try {
      const response = await this.client.get('/vendors');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching vendors:', error.message);
      throw error;
    }
  }

  /**
   * Get expense categories
   * @returns {Promise<Array>} Array of expense categories
   */
  async getExpenseCategories() {
    try {
      const response = await this.client.get('/expense_categories');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching expense categories:', error.message);
      throw error;
    }
  }

  /**
   * Create a new expense
   * @param {Object} expenseData - Expense data
   * @returns {Promise<Object>} Created expense
   */
  async createExpense(expenseData) {
    try {
      const response = await this.client.post('/expenses', expenseData);
      return response.data.data;
    } catch (error) {
      console.error('Error creating expense:', error.message);
      throw error;
    }
  }

  /**
   * Upload a document to an expense
   * @param {string} expenseId - The expense ID
   * @param {Buffer} fileBuffer - File buffer
   * @param {string} filename - File name
   * @returns {Promise<Object>} Upload response
   */
  async uploadExpenseDocument(expenseId, fileBuffer, filename) {
    try {
      const formData = new FormData();
      formData.append('file', fileBuffer, filename);
      formData.append('_method', 'PUT');

      const response = await this.client.post(
        `/expenses/${expenseId}/upload`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'X-Api-Token': this.token
          }
        }
      );
      return response.data;
    } catch (error) {
      console.error('Error uploading document:', error.message);
      throw error;
    }
  }
}

export default InvoiceNinjaClient;
