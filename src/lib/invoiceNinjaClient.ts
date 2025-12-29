import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

/**
 * Invoice Ninja API Response wrapper
 */
interface ApiResponse<T> {
  data: T;
}

/**
 * Expense interface
 */
export interface Expense {
  id?: string;
  amount: number;
  date?: string;
  expense_date?: string;
  public_notes?: string;
  description?: string;
  vendor_name?: string;
  vendor?: {
    name: string;
  };
  category_name?: string;
  category?: {
    name: string;
  };
}

/**
 * Client interface
 */
export interface Client {
  id: string;
  name: string;
}

/**
 * Vendor interface
 */
export interface Vendor {
  id: string;
  name: string;
}

/**
 * Expense Category interface
 */
export interface ExpenseCategory {
  id: string;
  name: string;
}

/**
 * Filter parameters for expenses
 */
export interface ExpenseFilters {
  per_page?: number;
  page?: number;
  [key: string]: any;
}

/**
 * Invoice Ninja API Client
 * Handles communication with self-hosted Invoice Ninja instance
 */
class InvoiceNinjaClient {
  private baseURL: string;
  private token: string;
  private client: AxiosInstance;

  constructor() {
    this.baseURL = process.env.INVOICE_NINJA_URL || '';
    this.token = process.env.INVOICE_NINJA_TOKEN || '';
    
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
   */
  async getExpenses(filters: ExpenseFilters = {}): Promise<Expense[]> {
    try {
      const response = await this.client.get<ApiResponse<Expense[]>>('/expenses', { params: filters });
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching expenses:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get a single expense by ID
   */
  async getExpense(expenseId: string): Promise<Expense> {
    try {
      const response = await this.client.get<ApiResponse<Expense>>(`/expenses/${expenseId}`);
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching expense ${expenseId}:`, (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all clients
   */
  async getClients(): Promise<Client[]> {
    try {
      const response = await this.client.get<ApiResponse<Client[]>>('/clients');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching clients:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all vendors
   */
  async getVendors(): Promise<Vendor[]> {
    try {
      const response = await this.client.get<ApiResponse<Vendor[]>>('/vendors');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching vendors:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get expense categories
   */
  async getExpenseCategories(): Promise<ExpenseCategory[]> {
    try {
      const response = await this.client.get<ApiResponse<ExpenseCategory[]>>('/expense_categories');
      return response.data.data || [];
    } catch (error) {
      console.error('Error fetching expense categories:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Create a new expense
   */
  async createExpense(expenseData: Partial<Expense>): Promise<Expense> {
    try {
      const response = await this.client.post<ApiResponse<Expense>>('/expenses', expenseData);
      return response.data.data;
    } catch (error) {
      console.error('Error creating expense:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Upload a document to an expense
   */
  async uploadExpenseDocument(expenseId: string, fileBuffer: Buffer, filename: string): Promise<any> {
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
      console.error('Error uploading document:', (error as Error).message);
      throw error;
    }
  }
}

export default InvoiceNinjaClient;
