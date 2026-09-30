const procurement = require('../../utils/procurement');
const config = require('../../utils/config');

const STATUS_MAP = {
  SUBMITTED: '待接单',
  ACCEPTED: '配货发货中',
  PARTIAL_DISPATCHED: '部分送达',
  PARTIALLY_DISPATCHED: '部分送达',
  DISPATCHED: '已全部出库',
  ALL_DISPATCHED: '已全部出库',
  COMPLETED: '已收货',
  CLOSED: '已结平关闭',
  REJECTED: '已驳回',
  CANCELLED: '已取消'
};

const DELIVERY_MAP = {
  PENDING: '待取货',
  PENDING_PICKUP: '待取货',
  IN_DELIVERY: '配送中',
  DELIVERING: '配送中',
  DELIVERED: '已送达',
  DELIVERY_FAILED: '配送异常',
  FAILED: '配送异常'
};

const RECEIPT_MAP = {
  PENDING: '待签收 (7天自动签收)',
  PENDING_RECEIPT: '待签收 (7天自动签收)',
  CONFIRMED: '已签收'
};

Page({
  data: {
    statusTabs: [
      { label: '全部', status: '' },
      { label: '待接单', status: 'SUBMITTED' },
      { label: '配货中', status: 'ACCEPTED' },
      { label: '全部发货', status: 'ALL_DISPATCHED' },
      { label: '已收货', status: 'COMPLETED' },
      { label: '已取消', status: 'CANCELLED' }
    ],
    currentStatus: '',
    orders: [],
    loading: false,
    expandedId: 0
  },

  onLoad: function(options) {
    if (options && options.status) {
      var status = options.status;
      if (status === 'PARTIAL_DISPATCHED' || status === 'PARTIALLY_DISPATCHED') {
        status = 'ACCEPTED';
      } else if (status === 'DISPATCHED') {
        status = 'ALL_DISPATCHED';
      }
      this.setData({ currentStatus: status });
    }
  },

  onShow: function() {
    this.loadOrders();
  },

  onPullDownRefresh: function() {
    var self = this;
    this.loadOrders().then(function() {
      wx.stopPullDownRefresh();
    });
  },

  onTabChange: function(e) {
    var status = e.currentTarget.dataset.status;
    this.setData({
      currentStatus: status,
      expandedId: 0
    });
    this.loadOrders();
  },

  loadOrders: function() {
    var self = this;
    self.setData({ loading: true });

    return procurement.request('proc_order_list', { status: self.data.currentStatus })
      .then(function(res) {
        if (res.status === 1) {
          var user = procurement.getUserInfo() || {};
          var storageKey = 'proc_deleted_cancelled_orders_' + (user.userId || 0);
          var deletedIds = wx.getStorageSync(storageKey) || [];

          var list = (res.list || []).filter(function(o) {
            return deletedIds.indexOf(o.id) < 0;
          });

          list.forEach(function(o) {
            o.orderStatusDesc = STATUS_MAP[o.orderStatus] || o.orderStatus;
            o.totalAmount = Number(o.totalAmount).toFixed(2);
            o.dispatchedAmount = Number(o.dispatchedAmount).toFixed(2);
            o.detail = null;
          });
          self.setData({ orders: list });
        } else {
          wx.showToast({ title: res.msg || '加载订单失败', icon: 'none' });
        }
      })
      .catch(function() {
        wx.showToast({ title: '网络请求失败', icon: 'none' });
      })
      .finally(function() {
        self.setData({ loading: false });
      });
  },

  toggleExpand: function(e) {
    var id = e.currentTarget.dataset.id;
    if (this.data.expandedId === id) {
      this.setData({ expandedId: 0 });
      return;
    }

    this.setData({ expandedId: id });
    this.loadOrderDetail(id);
  },

  loadOrderDetail: function(id) {
    var self = this;
    wx.showLoading({ title: '加载订单明细...' });

    procurement.request('proc_order_detail', { id: id })
      .then(function(res) {
        wx.hideLoading();
        if (res.status === 1 && res.order) {
          var orderDetail = res.order;
          if (orderDetail.shipments) {
            orderDetail.shipments.forEach(function(s) {
              s.deliveryStatusDesc = DELIVERY_MAP[s.deliveryStatus] || s.deliveryStatus;
              s.receiptStatusDesc = RECEIPT_MAP[s.receiptStatus] || s.receiptStatus;
            });
          }

          var orders = self.data.orders;
          for (var i = 0; i < orders.length; i++) {
            if (orders[i].id === id) {
              orders[i].detail = orderDetail;
              break;
            }
          }
          self.setData({ orders: orders });
        } else {
          wx.showToast({ title: res.msg || '加载明细失败', icon: 'none' });
        }
      })
      .catch(function() {
        wx.hideLoading();
        wx.showToast({ title: '加载明细异常', icon: 'none' });
      });
  },

  confirmReceipt: function(e) {
    var shipmentId = e.currentTarget.dataset.shipmentId;
    var self = this;

    wx.showModal({
      title: '确认收货',
      content: '确认已收到该出库批次对应耗材实物且验收无误？',
      success: function(sm) {
        if (sm.confirm) {
          wx.showLoading({ title: '提交确认中...' });
          procurement.request('proc_receipt_confirm', { shipmentId: shipmentId })
            .then(function(res) {
              wx.hideLoading();
              if (res.status === 1) {
                wx.showToast({ title: '收货确认成功', icon: 'success' });
                self.loadOrders().then(function() {
                  if (self.data.expandedId > 0) {
                    self.loadOrderDetail(self.data.expandedId);
                  }
                });
              } else {
                wx.showToast({ title: res.msg || '确认收货失败', icon: 'none' });
              }
            })
            .catch(function() {
              wx.hideLoading();
              wx.showToast({ title: '网络异常', icon: 'none' });
            });
        }
      }
    });
  },

  confirmAllReceipt: function(e) {
    var orderId = e.currentTarget.dataset.id;
    var self = this;

    wx.showModal({
      title: '全部收货确认',
      content: '确认已收到该订单下所有已出库的耗材，并将所有配送批次一键确认签收吗？',
      confirmText: '全部收货',
      confirmColor: '#0e7c7b',
      success: function(sm) {
        if (sm.confirm) {
          wx.showLoading({ title: '提交确认中...' });
          procurement.request('proc_order_all_receipt', { orderId: orderId })
            .then(function(res) {
              wx.hideLoading();
              if (res.status === 1) {
                wx.showToast({ title: '全部收货完成', icon: 'success' });
                self.loadOrders().then(function() {
                  if (self.data.expandedId === orderId) {
                    self.loadOrderDetail(orderId);
                  }
                });
              } else {
                wx.showToast({ title: res.msg || '操作失败', icon: 'none' });
              }
            })
            .catch(function() {
              wx.hideLoading();
              wx.showToast({ title: '网络异常', icon: 'none' });
            });
        }
      }
    });
  },

  cancelOrder: function(e) {
    var orderId = e.currentTarget.dataset.id;
    var self = this;

    wx.showModal({
      title: '取消订单确认',
      content: '确认取消此采购申请单吗？待接单状态取消后将释放暂占库存。',
      success: function(sm) {
        if (sm.confirm) {
          wx.showLoading({ title: '正在取消...' });
          procurement.request('proc_order_cancel', { orderId: orderId })
            .then(function(res) {
              wx.hideLoading();
              if (res.status === 1) {
                wx.showToast({ title: '订单已取消', icon: 'success' });
                self.loadOrders();
              } else {
                wx.showToast({ title: res.msg || '取消订单失败', icon: 'none' });
              }
            })
            .catch(function() {
              wx.hideLoading();
              wx.showToast({ title: '网络异常', icon: 'none' });
            });
        }
      }
    });
  },

  deleteCancelledOrder: function(e) {
    var self = this;
    var orderId = e.currentTarget.dataset.id;
    var orderNo = e.currentTarget.dataset.orderNo;
    var user = procurement.getUserInfo() || {};
    var storageKey = 'proc_deleted_cancelled_orders_' + (user.userId || 0);

    wx.showModal({
      title: '确认删除已取消订单？',
      content: '订单编号：' + (orderNo || '') + '\n删除后将从本地列表中移除（不同步后台数据）。',
      confirmText: '确认删除',
      cancelText: '取消',
      confirmColor: '#ef4444',
      success: function(sm) {
        if (sm.confirm) {
          var deletedIds = wx.getStorageSync(storageKey) || [];
          if (deletedIds.indexOf(orderId) < 0) {
            deletedIds.push(orderId);
            wx.setStorageSync(storageKey, deletedIds);
          }
          var filtered = self.data.orders.filter(function(o) {
            return o.id !== orderId;
          });
          self.setData({ orders: filtered });
          wx.showToast({ title: '订单已删除', icon: 'success' });
        }
      }
    });
  },

  exportOrdersExcel: function() {
    var token = procurement.getToken();
    var downloadUrl = config.API_HOST + '?action=proc_export_orders&token=' + encodeURIComponent(token);

    wx.showLoading({ title: '正在生成Excel表格...' });
    wx.downloadFile({
      url: downloadUrl,
      success: function(res) {
        wx.hideLoading();
        if (res.statusCode === 200) {
          wx.openDocument({
            filePath: res.tempFilePath,
            fileType: 'xlsx',
            showMenu: true,
            fail: function() {
              wx.showToast({ title: '无法打开表格或格式不支持', icon: 'none' });
            }
          });
        } else {
          wx.showToast({ title: '导出失败 (' + res.statusCode + ')', icon: 'none' });
        }
      },
      fail: function() {
        wx.hideLoading();
        wx.showToast({ title: '下载表格失败', icon: 'none' });
      }
    });
  },

  goToCatalog: function() {
    wx.switchTab({
      url: '/pages/order/index',
      fail: function() {
        wx.navigateTo({ url: '/pages/order/index' });
      }
    });
  }
});
