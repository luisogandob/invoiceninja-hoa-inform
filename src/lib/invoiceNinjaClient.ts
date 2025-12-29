import axios, { AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import FormData from 'form-data';

dotenv.config();

/**
 * Invoice Ninja API Response wrapper
 */
interface ApiResponse<T> {
  data: T;
  meta?: {
    pagination?: {
      total: number;
      count: number;
      per_page: number;
      current_page: number;
      total_pages: number;
    };
  };
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
 * Invoice interface (represents income)
 */
export interface Invoice {
  id?: string;
  amount: number;
  date?: string;
  invoice_date?: string;
  public_notes?: string;
  number?: string;
  client_name?: string;
  client?: {
    name: string;
  };
  status_id?: string;
  balance?: number;
  paid_to_date?: number;
}

/**
 * Filter parameters for expenses
 */
export interface ExpenseFilters {
  per_page?: number;
  page?: number;
  start_date?: string;  // Format: YYYY-MM-DD
  end_date?: string;    // Format: YYYY-MM-DD
  [key: string]: any;
}

/**
 * Filter parameters for invoices
 */
export interface InvoiceFilters {
  per_page?: number;
  page?: number;
  status?: string;
  start_date?: string;  // Format: YYYY-MM-DD
  end_date?: string;    // Format: YYYY-MM-DD
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
  private perPage: number;

  constructor() {
    this.baseURL = process.env.INVOICE_NINJA_URL || '';
    this.token = process.env.INVOICE_NINJA_TOKEN || '';
    this.perPage = parseInt(process.env.INVOICE_NINJA_PER_PAGE || '250', 10);
    
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
   * Get all expenses with optional filters and automatic pagination
   */
  async getExpenses(filters: ExpenseFilters = {}): Promise<Expense[]> {
    try {
      const allExpenses: Expense[] = [];
      let currentPage = 1;
      let hasMorePages = true;

      // Set default per_page if not provided
      const perPage = filters.per_page || this.perPage;

      while (hasMorePages) {
        const params = {
          ...filters,
          per_page: perPage,
          page: currentPage
        };

        const response = await this.client.get<ApiResponse<Expense[]>>('/expenses', { params });
        const expenses = response.data.data || [];
        allExpenses.push(...expenses);

        // Check if there are more pages
        const pagination = response.data.meta?.pagination;
        if (pagination && pagination.current_page < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }

        // Safety check: if no pagination info and we got fewer than per_page results, we're done
        if (!pagination && expenses.length < perPage) {
          hasMorePages = false;
        }
      }

      return allExpenses;
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
   * Get all clients with automatic pagination
   */
  async getClients(): Promise<Client[]> {
    try {
      const allClients: Client[] = [];
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const params = {
          per_page: this.perPage,
          page: currentPage
        };

        const response = await this.client.get<ApiResponse<Client[]>>('/clients', { params });
        const clients = response.data.data || [];
        allClients.push(...clients);

        // Check if there are more pages
        const pagination = response.data.meta?.pagination;
        if (pagination && pagination.current_page < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }

        // Safety check: if no pagination info and we got fewer than per_page results, we're done
        if (!pagination && clients.length < this.perPage) {
          hasMorePages = false;
        }
      }

      return allClients;
    } catch (error) {
      console.error('Error fetching clients:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get all vendors with automatic pagination
   */
  async getVendors(): Promise<Vendor[]> {
    try {
      const allVendors: Vendor[] = [];
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const params = {
          per_page: this.perPage,
          page: currentPage
        };

        const response = await this.client.get<ApiResponse<Vendor[]>>('/vendors', { params });
        const vendors = response.data.data || [];
        allVendors.push(...vendors);

        // Check if there are more pages
        const pagination = response.data.meta?.pagination;
        if (pagination && pagination.current_page < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }

        // Safety check: if no pagination info and we got fewer than per_page results, we're done
        if (!pagination && vendors.length < this.perPage) {
          hasMorePages = false;
        }
      }

      return allVendors;
    } catch (error) {
      console.error('Error fetching vendors:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get expense categories with automatic pagination
   */
  async getExpenseCategories(): Promise<ExpenseCategory[]> {
    try {
      const allCategories: ExpenseCategory[] = [];
      let currentPage = 1;
      let hasMorePages = true;

      while (hasMorePages) {
        const params = {
          per_page: this.perPage,
          page: currentPage
        };

        const response = await this.client.get<ApiResponse<ExpenseCategory[]>>('/expense_categories', { params });
        const categories = response.data.data || [];
        allCategories.push(...categories);

        // Check if there are more pages
        const pagination = response.data.meta?.pagination;
        if (pagination && pagination.current_page < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }

        // Safety check: if no pagination info and we got fewer than per_page results, we're done
        if (!pagination && categories.length < this.perPage) {
          hasMorePages = false;
        }
      }

      return allCategories;
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

  /**
   * Get all invoices with optional filters and automatic pagination
   */
  async getInvoices(filters: InvoiceFilters = {}): Promise<Invoice[]> {
    try {
      const allInvoices: Invoice[] = [];
      let currentPage = 1;
      let hasMorePages = true;

      // Set default per_page if not provided
      const perPage = filters.per_page || this.perPage;

      while (hasMorePages) {
        const params = {
          ...filters,
          per_page: perPage,
          page: currentPage
        };

        const response = await this.client.get<ApiResponse<Invoice[]>>('/invoices', { params });
        const invoices = response.data.data || [];
        allInvoices.push(...invoices);

        // Check if there are more pages
        const pagination = response.data.meta?.pagination;
        if (pagination && pagination.current_page < pagination.total_pages) {
          currentPage++;
        } else {
          hasMorePages = false;
        }

        // Safety check: if no pagination info and we got fewer than per_page results, we're done
        if (!pagination && invoices.length < perPage) {
          hasMorePages = false;
        }
      }

      return allInvoices;
    } catch (error) {
      console.error('Error fetching invoices:', (error as Error).message);
      throw error;
    }
  }

  /**
   * Get a single invoice by ID
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    try {
      const response = await this.client.get<ApiResponse<Invoice>>(`/invoices/${invoiceId}`);
      return response.data.data;
    } catch (error) {
      console.error(`Error fetching invoice ${invoiceId}:`, (error as Error).message);
      throw error;
    }
  }
}

export default InvoiceNinjaClient;
