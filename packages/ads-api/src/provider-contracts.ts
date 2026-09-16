/** Pinned public read contracts, 2026-09-15. Descriptions/examples and all mutation operations omitted. */
import type { ProviderEvidenceFamily } from "@wizard-ads/shared";
export interface ProviderWireSchema { type?: string; enum?: readonly unknown[]; required?: readonly string[]; minimum?: number; maximum?: number; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; nullable?: boolean; format?: string; allOf?: readonly ProviderWireSchema[]; oneOf?: readonly ProviderWireSchema[]; anyOf?: readonly ProviderWireSchema[]; properties?: Readonly<Record<string, ProviderWireSchema>>; items?: ProviderWireSchema; additionalProperties?: boolean | ProviderWireSchema }
export interface ProviderReadContract { operation: string; family: ProviderEvidenceFamily; path: string; method: "GET" | "POST"; contentType: string; accept: string; request: ProviderWireSchema; response: ProviderWireSchema; parameters: readonly { name: string; location: string; required: boolean; schema: ProviderWireSchema }[]; contractHash: string; provenance: string }
export const PROVIDER_READ_CONTRACTS: readonly ProviderReadContract[] = [
  {
    "operation": "tactical.ListRecommendations",
    "family": "tactical",
    "path": "/recommendations/list",
    "method": "POST",
    "contentType": "application/vnd.listRecommendationsRequest.v1+json",
    "accept": "application/vnd.listRecommendationsResponse.v1+json",
    "request": {
      "type": "object",
      "properties": {
        "filters": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "items": {
            "type": "object",
            "required": [
              "field",
              "operator",
              "values"
            ],
            "properties": {
              "field": {
                "type": "string",
                "enum": [
                  "AD_PRODUCT",
                  "CAMPAIGN_ID",
                  "GROUPING_TYPE",
                  "RECOMMENDATION_ID",
                  "RECOMMENDATION_TYPE",
                  "STATUS"
                ]
              },
              "include": {
                "type": "boolean"
              },
              "operator": {
                "type": "string",
                "enum": [
                  "EXACT"
                ]
              },
              "values": {
                "type": "array",
                "minItems": 1,
                "maxItems": 500,
                "items": {
                  "type": "string"
                }
              }
            }
          }
        },
        "locale": {
          "allOf": [
            {
              "type": "string",
              "enum": [
                "ar_AE",
                "cs_CZ",
                "de_DE",
                "en_AE",
                "en_AU",
                "en_CA",
                "en_GB",
                "en_IN",
                "en_SG",
                "en_US",
                "es_CO",
                "es_ES",
                "es_MX",
                "es_US",
                "fr_CA",
                "fr_FR",
                "he_IL",
                "hi_IN",
                "it_IT",
                "ja_JP",
                "ko_KR",
                "nl_NL",
                "pl_PL",
                "pt_BR",
                "sv_SE",
                "ta_IN",
                "th_TH",
                "tr_TR",
                "vi_VN",
                "zh_CN",
                "zh_TW"
              ]
            }
          ]
        },
        "maxResults": {
          "type": "integer",
          "minimum": 1,
          "maximum": 500
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "recommendations",
        "totalResults"
      ],
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "recommendations": {
          "type": "array",
          "minItems": 0,
          "maxItems": 500,
          "items": {
            "type": "object",
            "required": [
              "adProduct",
              "recommendationId",
              "recommendationType",
              "status"
            ],
            "properties": {
              "adGroupId": {
                "type": "string"
              },
              "adId": {
                "type": "string"
              },
              "adProduct": {
                "type": "string",
                "enum": [
                  "SB",
                  "SD",
                  "SP",
                  "ST"
                ]
              },
              "applyFailureReason": {
                "type": "string"
              },
              "asin": {
                "type": "string"
              },
              "asinGroupTemplateId": {
                "type": "string"
              },
              "budgetRecommendation": {
                "type": "object",
                "required": [
                  "sevenDaysMissedOpportunities"
                ],
                "properties": {
                  "sevenDaysMissedOpportunities": {
                    "type": "object",
                    "properties": {
                      "endDate": {
                        "type": "string",
                        "format": "date"
                      },
                      "estimatedMissedClicksLower": {
                        "type": "integer"
                      },
                      "estimatedMissedClicksUpper": {
                        "type": "integer"
                      },
                      "estimatedMissedImpressionsLower": {
                        "type": "integer"
                      },
                      "estimatedMissedImpressionsUpper": {
                        "type": "integer"
                      },
                      "estimatedMissedSalesLower": {
                        "type": "number"
                      },
                      "estimatedMissedSalesUpper": {
                        "type": "number"
                      },
                      "percentTimeInBudget": {
                        "type": "number"
                      },
                      "startDate": {
                        "type": "string",
                        "format": "date"
                      }
                    }
                  }
                }
              },
              "budgetRule": {
                "type": "object",
                "required": [
                  "ruleDetails"
                ],
                "properties": {
                  "ruleDetails": {
                    "type": "object",
                    "properties": {
                      "budgetIncreaseBy": {
                        "type": "object",
                        "required": [
                          "value"
                        ],
                        "properties": {
                          "value": {
                            "type": "number"
                          }
                        }
                      },
                      "duration": {
                        "type": "object",
                        "properties": {
                          "dateRangeTypeDuration": {
                            "type": "object",
                            "required": [
                              "startDate"
                            ],
                            "properties": {
                              "endDate": {
                                "type": "string",
                                "format": "date"
                              },
                              "startDate": {
                                "type": "string",
                                "format": "date"
                              }
                            }
                          },
                          "eventTypeDuration": {
                            "type": "object",
                            "required": [
                              "eventId"
                            ],
                            "properties": {
                              "endDate": {
                                "type": "string",
                                "format": "date"
                              },
                              "eventId": {
                                "type": "string"
                              },
                              "startDate": {
                                "type": "string",
                                "format": "date"
                              }
                            }
                          }
                        }
                      },
                      "performanceMeasureCondition": {
                        "type": "object",
                        "required": [
                          "threshold"
                        ],
                        "properties": {
                          "threshold": {
                            "type": "number"
                          }
                        }
                      },
                      "ruleName": {
                        "type": "string"
                      },
                      "ruleType": {
                        "type": "string"
                      }
                    }
                  },
                  "ruleId": {
                    "type": "string"
                  }
                }
              },
              "campaignId": {
                "type": "string"
              },
              "campaignTemplateId": {
                "type": "string"
              },
              "consolidatedRecommendation": {
                "type": "object",
                "properties": {
                  "recommendationReasons": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 100,
                    "items": {
                      "type": "string",
                      "enum": [
                        "AT_BID_FALLBACK",
                        "AT_NOT_ALL_MATCH_TYPE_ENABLED",
                        "MT_BID_FALLBACK",
                        "MT_IRRELEVANT_KEYWORD_IMPRESSIONS",
                        "MT_KEYWORDS_HAVE_LOW_IMPRESSIONS",
                        "MT_KEYWORD_FALLBACK",
                        "MT_NOT_ENOUGH_TOP_IMPRESSIONS"
                      ]
                    }
                  },
                  "sevenDaysEstimatedOpportunities": {
                    "type": "object",
                    "required": [
                      "endDate",
                      "startDate"
                    ],
                    "properties": {
                      "endDate": {
                        "type": "string",
                        "format": "date-time"
                      },
                      "estimatedIncrementalClicksLower": {
                        "type": "integer"
                      },
                      "estimatedIncrementalClicksUpper": {
                        "type": "integer"
                      },
                      "startDate": {
                        "type": "string",
                        "format": "date-time"
                      }
                    }
                  }
                }
              },
              "currentValue": {
                "type": "string"
              },
              "estimatedImpact": {
                "type": "object",
                "properties": {
                  "campaign": {
                    "type": "object",
                    "required": [
                      "timePeriodInDays"
                    ],
                    "properties": {
                      "clicks": {
                        "type": "object",
                        "properties": {
                          "forecastedCurrentLowerBound": {
                            "type": "number"
                          },
                          "forecastedCurrentUpperBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedLowerBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedUpperBound": {
                            "type": "number"
                          },
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "cohortTopOfSearchImpressionShare": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "cost": {
                        "type": "object",
                        "properties": {
                          "forecastedCurrentLowerBound": {
                            "type": "number"
                          },
                          "forecastedCurrentUpperBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedLowerBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedUpperBound": {
                            "type": "number"
                          },
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "impressions": {
                        "type": "object",
                        "properties": {
                          "forecastedCurrentLowerBound": {
                            "type": "number"
                          },
                          "forecastedCurrentUpperBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedLowerBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedUpperBound": {
                            "type": "number"
                          },
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "incrementalSalesIncrementalCostRatio": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "opportunityLostPurchaseJourney": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "opportunityLostToCompetitors": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "opportunityLostToCompetitorsPercentage": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "opportunityLostToCompetitorsSales": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "roas": {
                        "type": "object",
                        "properties": {
                          "forecastedCurrentLowerBound": {
                            "type": "number"
                          },
                          "forecastedCurrentUpperBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedLowerBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedUpperBound": {
                            "type": "number"
                          },
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "sales": {
                        "type": "object",
                        "properties": {
                          "forecastedCurrentLowerBound": {
                            "type": "number"
                          },
                          "forecastedCurrentUpperBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedLowerBound": {
                            "type": "number"
                          },
                          "forecastedRecommendedUpperBound": {
                            "type": "number"
                          },
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      },
                      "timePeriodInDays": {
                        "type": "integer"
                      },
                      "topOfSearchImpressionShare": {
                        "type": "object",
                        "required": [
                          "incrementalLowerBound",
                          "incrementalUpperBound"
                        ],
                        "properties": {
                          "incrementalLowerBound": {
                            "type": "number"
                          },
                          "incrementalUpperBound": {
                            "type": "number"
                          }
                        }
                      }
                    }
                  }
                }
              },
              "groupingType": {
                "type": "string",
                "enum": [
                  "ADD_TARGETS_CONTEXTUAL",
                  "CAMPAIGN_INCREASE_CLICKS",
                  "DECREASE_BID_CONTEXTUAL",
                  "INCREASE_BID_CONTEXTUAL",
                  "INCREASE_BUDGET_CONTEXTUAL",
                  "INCREASE_CLICKTHROUGH_RATE",
                  "INCREASE_CONVERSION_RATE",
                  "IN_SEASON_ASIN",
                  "NEW_ASIN",
                  "NEW_CAMPAIGN_ATTRIBUTED_ORDERS",
                  "NEW_CAMPAIGN_CLICKS",
                  "NEW_CAMPAIGN_GROW_BIS_IMAGE_GENERAL",
                  "NEW_CAMPAIGN_GROW_BIS_IMAGE_SPECIFIC",
                  "NEW_CAMPAIGN_GROW_BRAND_IMPRESSION_SHARE",
                  "NEW_CAMPAIGN_NEW_TO_BRAND_ORDERS",
                  "NEW_CAMPAIGN_PRE_COMPUTED_RECOMMENDATION_BUNDLE",
                  "NEW_CAMPAIGN_SPB_GOAL_BASED",
                  "OPTIMIZE_ATTRIBUTED_ORDERS",
                  "OPTIMIZE_BRANDED_SEARCHES",
                  "OPTIMIZE_CLICKS",
                  "OPTIMIZE_COST_PER_BRANDED_SEARCH",
                  "OPTIMIZE_COST_PER_CLICK",
                  "OPTIMIZE_COST_PER_DETAIL_PAGE_VIEW",
                  "OPTIMIZE_COST_PER_NEW_TO_BRAND_ORDERS",
                  "OPTIMIZE_DETAIL_PAGE_VIEWS",
                  "OPTIMIZE_NEW_TO_BRAND_ORDERS",
                  "OPTIMIZE_ROAS",
                  "OPTIMIZE_SPB_GOAL_BASED",
                  "ST_NE_NEW_CAMPAIGN_CREATION",
                  "UNDERPERFORMING_CAMPAIGN_INCREASE_CLICKS"
                ]
              },
              "keywordSortingDimension": {
                "type": "string",
                "enum": [
                  "CLICK",
                  "CONVERSION"
                ]
              },
              "keywordSortingRank": {
                "type": "integer"
              },
              "publishMetadata": {
                "type": "object",
                "required": [
                  "publishedBy",
                  "publishedToAmazonAdConsole"
                ],
                "properties": {
                  "publishedBy": {
                    "type": "string",
                    "enum": [
                      "AMAZON_ADS_ACCOUNT_TEAM"
                    ]
                  },
                  "publishedToAmazonAdConsole": {
                    "type": "boolean"
                  }
                }
              },
              "recommendationContext": {
                "type": "object",
                "properties": {
                  "asinContext": {
                    "type": "object",
                    "properties": {
                      "seasonEndDate": {
                        "type": "string",
                        "format": "date"
                      },
                      "seasonStartDate": {
                        "type": "string",
                        "format": "date"
                      },
                      "trailing4WeeksClickthroughRate": {
                        "type": "number"
                      },
                      "trailing4WeeksConversionRate": {
                        "type": "number"
                      }
                    }
                  },
                  "diagnosticContext": {
                    "type": "object",
                    "properties": {
                      "asinAge": {
                        "type": "number"
                      },
                      "benchmarkContext": {
                        "type": "object",
                        "properties": {
                          "adSpend": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "attributedOrders": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "brandedSearches": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "budgetUtilization": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "clickthroughRate": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "costPerBrandedSearch": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "costPerDetailPageView": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "detailPageViews": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "impressions": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          },
                          "roas": {
                            "type": "object",
                            "properties": {
                              "benchmarkValue": {
                                "type": "number"
                              },
                              "percentDifference": {
                                "type": "number"
                              },
                              "period": {
                                "type": "number"
                              }
                            }
                          }
                        }
                      },
                      "diagnosticDate": {
                        "type": "string",
                        "format": "date"
                      },
                      "summary": {
                        "type": "object",
                        "properties": {
                          "code": {
                            "type": "string",
                            "enum": [
                              "ADD_TARGETS_CONTEXTUAL_SUMMARY",
                              "DECREASE_BID_CONTEXTUAL_SUMMARY",
                              "INCREASE_BID_CONTEXTUAL_SUMMARY",
                              "INCREASE_BUDGET_CONTEXTUAL_SUMMARY"
                            ]
                          },
                          "message": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  }
                }
              },
              "recommendationId": {
                "type": "string"
              },
              "recommendationType": {
                "type": "string",
                "enum": [
                  "AD_GROUP_BID_OPTIMIZATION",
                  "AD_GROUP_DEFAULT_BID",
                  "AD_GROUP_STATE",
                  "AMAZON_BUSINESS_BID_BOOST",
                  "AUDIENCE_COHORT_BID_BOOST",
                  "AUDIENCE_TARGETING_BID",
                  "AUDIENCE_TARGETING_STATE",
                  "CAMPAIGN_BIDDING_RULE",
                  "CAMPAIGN_BIDDING_STRATEGY",
                  "CAMPAIGN_BUDGET",
                  "CAMPAIGN_BUDGET_RULE",
                  "CAMPAIGN_END_DATE",
                  "CAMPAIGN_PRODUCT_PLACEMENT",
                  "CAMPAIGN_STATE",
                  "CAMPAIGN_TOP_PLACEMENT",
                  "KEYWORD_BID",
                  "KEYWORD_STATE",
                  "NEGATIVE_AUDIENCE_TARGETING_STATE",
                  "NEGATIVE_KEYWORD_STATE",
                  "NEGATIVE_PRODUCT_TARGETING_STATE",
                  "NEW_AD_GROUP",
                  "NEW_AUDIENCE_TARGETING",
                  "NEW_CAMPAIGN",
                  "NEW_CAMPAIGN_BIDDING_RULE",
                  "NEW_CAMPAIGN_BUDGET_RULE",
                  "NEW_KEYWORD",
                  "NEW_NEGATIVE_AUDIENCE_TARGETING",
                  "NEW_NEGATIVE_KEYWORD",
                  "NEW_NEGATIVE_PRODUCT_TARGETING",
                  "NEW_PRODUCT_AD",
                  "NEW_PRODUCT_TARGETING",
                  "NEW_VIDEO_CAMPAIGN",
                  "PRODUCT_AD_STATE",
                  "PRODUCT_TARGETING_BID",
                  "PRODUCT_TARGETING_STATE"
                ]
              },
              "recommendedValue": {
                "type": "string"
              },
              "resolvedTargeting": {
                "type": "string"
              },
              "ruleBasedBidding": {
                "type": "object",
                "required": [
                  "recommendedBiddingStrategy",
                  "recommendedRuleRoas"
                ],
                "properties": {
                  "campaignOptimizationId": {
                    "type": "string"
                  },
                  "currentBiddingStrategy": {
                    "type": "string",
                    "enum": [
                      "AUTO_FOR_SALES",
                      "LEGACY_FOR_SALES",
                      "MANUAL",
                      "RULE_BASED"
                    ]
                  },
                  "currentRuleRoas": {
                    "type": "number"
                  },
                  "recommendedBiddingStrategy": {
                    "type": "string",
                    "enum": [
                      "AUTO_FOR_SALES",
                      "LEGACY_FOR_SALES",
                      "MANUAL",
                      "RULE_BASED"
                    ]
                  },
                  "recommendedRuleRoas": {
                    "type": "number"
                  }
                }
              },
              "sku": {
                "type": "string"
              },
              "status": {
                "type": "string",
                "enum": [
                  "APPLY_FAILED",
                  "APPLY_IN_PROGRESS",
                  "APPLY_SUCCESS",
                  "PUBLISHED",
                  "REJECTED"
                ]
              },
              "targetId": {
                "type": "string"
              },
              "targeting": {
                "type": "string"
              },
              "targetingMatchType": {
                "type": "string",
                "enum": [
                  "BROAD",
                  "EXACT",
                  "GROUP",
                  "NEGATIVE_BROAD",
                  "NEGATIVE_EXACT",
                  "NEGATIVE_PHRASE",
                  "PHRASE",
                  "TARGETING_EXPRESSION",
                  "TARGETING_EXPRESSION_PREDEFINED",
                  "THEME"
                ]
              }
            }
          }
        },
        "totalResults": {
          "type": "integer"
        }
      }
    },
    "parameters": [],
    "contractHash": "9b733731ebcb609efcf6f8516a2337bf73bf5cf82eb941dccaee91b7e6a3cdc8",
    "provenance": "https://dtrnk0o2zy01c.cloudfront.net/openapi/en-us/dest/Recommendations_prod_3p.json"
  },
  {
    "operation": "sp.GetSPBudgetRulesForAdvertiser",
    "family": "sp-budget",
    "path": "/sp/budgetRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "budgetRulesForAdvertiserResponse": {
          "type": "array",
          "minItems": 0,
          "maxItems": 30,
          "items": {
            "type": "object",
            "required": [
              "ruleId"
            ],
            "properties": {
              "createdDate": {
                "type": "number",
                "format": "int64"
              },
              "lastUpdatedDate": {
                "type": "number",
                "format": "int64"
              },
              "ruleDetails": {
                "type": "object",
                "properties": {
                  "budgetIncreaseBy": {
                    "type": "object",
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "PERCENT"
                        ]
                      },
                      "value": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "duration": {
                    "type": "object",
                    "properties": {
                      "dateRangeTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "startDate"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      },
                      "eventTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "eventId"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "eventId": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 355
                  },
                  "performanceMeasureCondition": {
                    "type": "object",
                    "required": [
                      "comparisonOperator",
                      "metricName",
                      "threshold"
                    ],
                    "properties": {
                      "comparisonOperator": {
                        "type": "string",
                        "enum": [
                          "EQUAL_TO",
                          "GREATER_THAN",
                          "GREATER_THAN_OR_EQUAL_TO",
                          "LESS_THAN",
                          "LESS_THAN_OR_EQUAL_TO"
                        ]
                      },
                      "metricName": {
                        "type": "string",
                        "enum": [
                          "ACOS",
                          "CTR",
                          "CVR",
                          "ROAS"
                        ]
                      },
                      "threshold": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "daysOfWeek": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "FRIDAY",
                            "MONDAY",
                            "SATURDAY",
                            "SUNDAY",
                            "THURSDAY",
                            "TUESDAY",
                            "WEDNESDAY"
                          ]
                        }
                      },
                      "intraDaySchedule": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "properties": {
                            "endTime": {
                              "type": "string"
                            },
                            "startTime": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY"
                        ]
                      }
                    }
                  },
                  "ruleType": {
                    "type": "string",
                    "enum": [
                      "PERFORMANCE",
                      "SCHEDULE"
                    ]
                  }
                }
              },
              "ruleId": {
                "type": "string"
              },
              "ruleState": {
                "type": "string",
                "enum": [
                  "ACTIVE",
                  "PAUSED"
                ]
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "pageSize",
        "location": "query",
        "required": true,
        "schema": {
          "type": "number"
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetBudgetRuleByRuleIdForSPCampaigns",
    "family": "sp-budget",
    "path": "/sp/budgetRules/{budgetRuleId}",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "budgetRule": {
          "type": "object",
          "required": [
            "ruleId"
          ],
          "properties": {
            "createdDate": {
              "type": "number",
              "format": "int64"
            },
            "lastUpdatedDate": {
              "type": "number",
              "format": "int64"
            },
            "ruleDetails": {
              "type": "object",
              "properties": {
                "budgetIncreaseBy": {
                  "type": "object",
                  "required": [
                    "type",
                    "value"
                  ],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "PERCENT"
                      ]
                    },
                    "value": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                },
                "duration": {
                  "type": "object",
                  "properties": {
                    "dateRangeTypeRuleDuration": {
                      "type": "object",
                      "required": [
                        "startDate"
                      ],
                      "properties": {
                        "endDate": {
                          "type": "string"
                        },
                        "startDate": {
                          "type": "string"
                        }
                      }
                    },
                    "eventTypeRuleDuration": {
                      "type": "object",
                      "required": [
                        "eventId"
                      ],
                      "properties": {
                        "endDate": {
                          "type": "string"
                        },
                        "eventId": {
                          "type": "string"
                        },
                        "eventName": {
                          "type": "string"
                        },
                        "startDate": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "name": {
                  "type": "string",
                  "maxLength": 355
                },
                "performanceMeasureCondition": {
                  "type": "object",
                  "required": [
                    "comparisonOperator",
                    "metricName",
                    "threshold"
                  ],
                  "properties": {
                    "comparisonOperator": {
                      "type": "string",
                      "enum": [
                        "EQUAL_TO",
                        "GREATER_THAN",
                        "GREATER_THAN_OR_EQUAL_TO",
                        "LESS_THAN",
                        "LESS_THAN_OR_EQUAL_TO"
                      ]
                    },
                    "metricName": {
                      "type": "string",
                      "enum": [
                        "ACOS",
                        "CTR",
                        "CVR",
                        "ROAS"
                      ]
                    },
                    "threshold": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                },
                "recurrence": {
                  "type": "object",
                  "properties": {
                    "daysOfWeek": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "FRIDAY",
                          "MONDAY",
                          "SATURDAY",
                          "SUNDAY",
                          "THURSDAY",
                          "TUESDAY",
                          "WEDNESDAY"
                        ]
                      }
                    },
                    "intraDaySchedule": {
                      "type": "array",
                      "maxItems": 1,
                      "items": {
                        "type": "object",
                        "properties": {
                          "endTime": {
                            "type": "string"
                          },
                          "startTime": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "type": {
                      "type": "string",
                      "enum": [
                        "DAILY"
                      ]
                    }
                  }
                },
                "ruleType": {
                  "type": "string",
                  "enum": [
                    "PERFORMANCE",
                    "SCHEDULE"
                  ]
                }
              }
            },
            "ruleId": {
              "type": "string"
            },
            "ruleState": {
              "type": "string",
              "enum": [
                "ACTIVE",
                "PAUSED"
              ]
            },
            "ruleStatus": {
              "type": "string"
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "budgetRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetCampaignsAssociatedWithSPBudgetRule",
    "family": "sp-budget",
    "path": "/sp/budgetRules/{budgetRuleId}/campaigns",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "associatedCampaigns": {
          "type": "array",
          "minItems": 0,
          "maxItems": 30,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "campaignName",
              "ruleStatus"
            ],
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "campaignName": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "budgetRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "pageSize",
        "location": "query",
        "required": true,
        "schema": {
          "type": "number"
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getCampaignRecommendations",
    "family": "sp-budget",
    "path": "/sp/campaign/recommendations",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.spgetcampaignrecommendationsresponse.v1+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "required": [
        "recommendations"
      ],
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "recommendations": {
          "type": "array",
          "minItems": 0,
          "maxItems": 50,
          "items": {
            "type": "object",
            "properties": {
              "biddingStrategyRecommendation": {
                "type": "object",
                "properties": {
                  "action": {
                    "type": "string",
                    "enum": [
                      "UPDATE"
                    ]
                  },
                  "suggestedBiddingStrategy": {
                    "type": "string",
                    "enum": [
                      "AUTO_FOR_SALES",
                      "LEGACY_FOR_SALES",
                      "MANUAL"
                    ]
                  }
                }
              },
              "budgetRecommendation": {
                "type": "object",
                "properties": {
                  "action": {
                    "type": "string",
                    "enum": [
                      "DECREASE",
                      "INCREASE"
                    ]
                  },
                  "suggestedBudget": {
                    "type": "number",
                    "format": "double"
                  }
                }
              },
              "campaignId": {
                "type": "string"
              },
              "keywordTargetingRecommendations": {
                "type": "array",
                "minItems": 0,
                "maxItems": 50,
                "items": {
                  "type": "object",
                  "properties": {
                    "action": {
                      "type": "string",
                      "enum": [
                        "ADD",
                        "DECREASE",
                        "INCREASE",
                        "REMOVE",
                        "UPDATE"
                      ]
                    },
                    "adGroupId": {
                      "type": "string"
                    },
                    "keywordId": {
                      "type": "string"
                    },
                    "keywordText": {
                      "type": "string"
                    },
                    "matchType": {
                      "type": "string",
                      "enum": [
                        "BROAD",
                        "EXACT",
                        "GROUP",
                        "PHRASE"
                      ]
                    },
                    "suggestedBid": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                }
              },
              "placementBiddingRecommendations": {
                "type": "array",
                "minItems": 0,
                "maxItems": 50,
                "items": {
                  "type": "object",
                  "properties": {
                    "action": {
                      "type": "string",
                      "enum": [
                        "ADD",
                        "DECREASE",
                        "INCREASE",
                        "REMOVE"
                      ]
                    },
                    "incrementalImpressionsLowerPercent": {
                      "type": "integer"
                    },
                    "incrementalImpressionsUpperPercent": {
                      "type": "integer"
                    },
                    "placementType": {
                      "type": "string",
                      "enum": [
                        "PLACEMENT_PRODUCT_PAGE",
                        "PLACEMENT_REST_OF_SEARCH",
                        "PLACEMENT_TOP"
                      ]
                    },
                    "suggestedBidAdjustment": {
                      "type": "number",
                      "format": "integer"
                    }
                  }
                }
              },
              "sevenDaysEstimatedOpportunities": {
                "properties": {
                  "endDate": {
                    "type": "string"
                  },
                  "estimatedIncrementalClicksLower": {
                    "type": "integer"
                  },
                  "estimatedIncrementalClicksUpper": {
                    "type": "integer"
                  },
                  "startDate": {
                    "type": "string"
                  }
                }
              },
              "targetingGroupBidRecommendations": {
                "type": "array",
                "minItems": 0,
                "maxItems": 50,
                "items": {
                  "type": "object",
                  "properties": {
                    "action": {
                      "type": "string",
                      "enum": [
                        "ADD",
                        "DECREASE",
                        "INCREASE",
                        "REMOVE"
                      ]
                    },
                    "adGroupId": {
                      "type": "string"
                    },
                    "suggestedBid": {
                      "type": "number",
                      "format": "double"
                    },
                    "targetId": {
                      "type": "string"
                    },
                    "targetingGroupExpression": {
                      "type": "string",
                      "enum": [
                        "CLOSE_MATCH",
                        "COMPLEMENTS",
                        "LOOSE_MATCH",
                        "SUBSTITUTES"
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "campaignIds",
        "location": "query",
        "required": false,
        "schema": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      },
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "maxResults",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.fetchCampaignRecommendations",
    "family": "sp-budget",
    "path": "/sp/campaign/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spgetcampaignrecommendationsrequest.v2+json",
    "accept": "application/vnd.spgetcampaignrecommendationsresponse.v2+json",
    "request": {
      "type": "object",
      "required": [
        "campaigns"
      ],
      "properties": {
        "campaigns": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "recommendationType"
            ],
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "recommendationType": {
                "type": "string",
                "enum": [
                  "BIDDING_STRATEGY",
                  "BUDGET_STRATEGY",
                  "KEYWORD",
                  "KEYWORD_GROUP",
                  "PLACEMENT_BIDDING",
                  "SHOPPER_COHORT"
                ]
              }
            }
          }
        },
        "maxResults": {
          "type": "integer",
          "minimum": 1,
          "maximum": 5
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "recommendations"
      ],
      "properties": {
        "nextToken": {
          "type": "string",
          "nullable": true
        },
        "recommendations": {
          "type": "array",
          "minItems": 0,
          "maxItems": 50,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "recommendationDetails",
              "recommendationType"
            ],
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "forecastEstimates": {
                "properties": {
                  "endDate": {
                    "type": "string"
                  },
                  "estimatedAdSpendLower": {
                    "type": "number",
                    "format": "double"
                  },
                  "estimatedAdSpendUpper": {
                    "type": "number",
                    "format": "double"
                  },
                  "estimatedIncrementalClicksLower": {
                    "type": "integer"
                  },
                  "estimatedIncrementalClicksUpper": {
                    "type": "integer"
                  },
                  "estimatedIncrementalConversionsLower": {
                    "type": "integer"
                  },
                  "estimatedIncrementalConversionsUpper": {
                    "type": "integer"
                  },
                  "estimatedIncrementalImpressionsLower": {
                    "type": "integer"
                  },
                  "estimatedIncrementalImpressionsUpper": {
                    "type": "integer"
                  },
                  "estimatedIncrementalSalesLower": {
                    "type": "number",
                    "format": "double"
                  },
                  "estimatedIncrementalSalesUpper": {
                    "type": "number",
                    "format": "double"
                  },
                  "startDate": {
                    "type": "string"
                  }
                }
              },
              "recommendationDetails": {
                "type": "object",
                "anyOf": [
                  {
                    "required": [
                      "shopperCohortBiddingRecommendation"
                    ]
                  },
                  {
                    "required": [
                      "budgetRecommendation"
                    ]
                  },
                  {
                    "required": [
                      "biddingStrategyRecommendation"
                    ]
                  },
                  {
                    "required": [
                      "targetingGroupBidRecommendations"
                    ]
                  },
                  {
                    "required": [
                      "keywordTargetingRecommendations"
                    ]
                  },
                  {
                    "required": [
                      "placementBiddingRecommendations"
                    ]
                  }
                ],
                "properties": {
                  "biddingStrategyRecommendation": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "enum": [
                          "UPDATE"
                        ]
                      },
                      "suggestedBiddingStrategy": {
                        "type": "string",
                        "enum": [
                          "AUTO_FOR_SALES",
                          "LEGACY_FOR_SALES",
                          "MANUAL"
                        ]
                      }
                    }
                  },
                  "budgetRecommendation": {
                    "type": "object",
                    "properties": {
                      "action": {
                        "type": "string",
                        "enum": [
                          "DECREASE",
                          "INCREASE"
                        ]
                      },
                      "suggestedBudget": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "keywordTargetingRecommendations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 10,
                    "items": {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "enum": [
                            "ADD",
                            "DECREASE",
                            "INCREASE",
                            "REMOVE",
                            "UPDATE"
                          ]
                        },
                        "adGroupId": {
                          "type": "string"
                        },
                        "keywordId": {
                          "type": "string"
                        },
                        "keywordText": {
                          "type": "string"
                        },
                        "matchType": {
                          "type": "string",
                          "enum": [
                            "BROAD",
                            "EXACT",
                            "GROUP",
                            "PHRASE"
                          ]
                        },
                        "suggestedBid": {
                          "type": "number",
                          "format": "double"
                        }
                      }
                    }
                  },
                  "placementBiddingRecommendations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 10,
                    "items": {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "enum": [
                            "ADD",
                            "DECREASE",
                            "INCREASE",
                            "REMOVE"
                          ]
                        },
                        "incrementalImpressionsLowerPercent": {
                          "type": "integer"
                        },
                        "incrementalImpressionsUpperPercent": {
                          "type": "integer"
                        },
                        "placementType": {
                          "type": "string",
                          "enum": [
                            "PLACEMENT_PRODUCT_PAGE",
                            "PLACEMENT_REST_OF_SEARCH",
                            "PLACEMENT_TOP"
                          ]
                        },
                        "suggestedBidAdjustment": {
                          "type": "number",
                          "format": "integer"
                        }
                      }
                    }
                  },
                  "shopperCohortBiddingRecommendation": {
                    "type": "object",
                    "required": [
                      "action",
                      "audienceSegments",
                      "percentage",
                      "shopperCohortType"
                    ],
                    "properties": {
                      "action": {
                        "type": "string",
                        "enum": [
                          "ADD",
                          "REMOVE",
                          "UPDATE"
                        ]
                      },
                      "audienceSegments": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 10,
                        "items": {
                          "type": "object",
                          "required": [
                            "audienceId",
                            "audienceSegmentType"
                          ],
                          "properties": {
                            "audienceId": {
                              "type": "string"
                            },
                            "audienceSegmentType": {
                              "type": "string",
                              "enum": [
                                "BEHAVIOR_DYNAMIC",
                                "SPONSORED_ADS_AMC"
                              ]
                            }
                          }
                        }
                      },
                      "percentage": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 900
                      },
                      "shopperCohortType": {
                        "type": "string",
                        "enum": [
                          "AUDIENCE_SEGMENT"
                        ]
                      }
                    }
                  },
                  "targetingGroupBidRecommendations": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 10,
                    "items": {
                      "type": "object",
                      "properties": {
                        "action": {
                          "type": "string",
                          "enum": [
                            "ADD",
                            "DECREASE",
                            "INCREASE",
                            "REMOVE"
                          ]
                        },
                        "adGroupId": {
                          "type": "string"
                        },
                        "suggestedBid": {
                          "type": "number",
                          "format": "double"
                        },
                        "targetId": {
                          "type": "string"
                        },
                        "targetingGroupExpression": {
                          "type": "string",
                          "enum": [
                            "CLOSE_MATCH",
                            "COMPLEMENTS",
                            "LOOSE_MATCH",
                            "SUBSTITUTES"
                          ]
                        }
                      }
                    }
                  }
                }
              },
              "recommendationType": {
                "type": "string",
                "enum": [
                  "BIDDING_STRATEGY",
                  "BUDGET_STRATEGY",
                  "KEYWORD",
                  "KEYWORD_GROUP",
                  "PLACEMENT_BIDDING",
                  "SHOPPER_COHORT"
                ]
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getBudgetRecommendations",
    "family": "sp-budget",
    "path": "/sp/campaigns/budgetRecommendations",
    "method": "POST",
    "contentType": "application/vnd.budgetrecommendation.v3+json",
    "accept": "application/vnd.budgetrecommendation.v3+json",
    "request": {
      "type": "object",
      "required": [
        "campaignIds"
      ],
      "properties": {
        "campaignIds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "budgetRecommendationsErrorResults",
        "budgetRecommendationsSuccessResults"
      ],
      "properties": {
        "budgetRecommendationsErrorResults": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "Error",
              "campaignId",
              "index"
            ],
            "properties": {
              "Error": {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "details": {
                    "type": "string"
                  }
                }
              },
              "campaignId": {
                "type": "string"
              },
              "index": {
                "type": "integer"
              }
            }
          }
        },
        "budgetRecommendationsSuccessResults": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "budgetRuleRecommendation",
              "campaignId",
              "index",
              "sevenDaysMissedOpportunities",
              "suggestedBudget"
            ],
            "properties": {
              "budgetRuleRecommendation": {
                "type": "object",
                "properties": {
                  "ruleId": {
                    "type": "string"
                  },
                  "ruleName": {
                    "type": "string"
                  },
                  "suggestedBudgetIncreasePercent": {
                    "type": "number"
                  }
                }
              },
              "campaignId": {
                "type": "string"
              },
              "index": {
                "type": "integer"
              },
              "sevenDaysMissedOpportunities": {
                "type": "object",
                "properties": {
                  "endDate": {
                    "type": "string"
                  },
                  "estimatedMissedClicksLower": {
                    "type": "integer"
                  },
                  "estimatedMissedClicksUpper": {
                    "type": "integer"
                  },
                  "estimatedMissedImpressionsLower": {
                    "type": "integer"
                  },
                  "estimatedMissedImpressionsUpper": {
                    "type": "integer"
                  },
                  "estimatedMissedSalesLower": {
                    "type": "number"
                  },
                  "estimatedMissedSalesUpper": {
                    "type": "number"
                  },
                  "percentTimeInBudget": {
                    "type": "number"
                  },
                  "startDate": {
                    "type": "string"
                  }
                }
              },
              "suggestedBudget": {
                "type": "number"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.SPGetBudgetRulesRecommendation",
    "family": "sp-budget",
    "path": "/sp/campaigns/budgetRules/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spbudgetrulesrecommendation.v3+json",
    "accept": "application/vnd.spbudgetrulesrecommendation.v3+json",
    "request": {
      "oneOf": [
        {
          "type": "object",
          "required": [
            "campaignId"
          ],
          "properties": {
            "campaignId": {
              "type": "string"
            }
          }
        }
      ]
    },
    "response": {
      "type": "object",
      "properties": {
        "recommendedBudgetRuleEvents": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "endDate": {
                "type": "string"
              },
              "eventId": {
                "type": "string"
              },
              "eventName": {
                "type": "string"
              },
              "startDate": {
                "type": "string"
              },
              "suggestedBudgetIncreasePercent": {
                "type": "number"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getBudgetRecommendation",
    "family": "sp-budget",
    "path": "/sp/campaigns/initialBudgetRecommendation",
    "method": "POST",
    "contentType": "application/vnd.spinitialbudgetrecommendation.v3.4+json",
    "accept": "application/vnd.spinitialbudgetrecommendation.v3.4+json",
    "request": {
      "type": "object",
      "required": [
        "adGroups",
        "bidding",
        "targetingType"
      ],
      "properties": {
        "adGroups": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1,
          "items": {
            "required": [
              "asins",
              "targetingExpressions"
            ],
            "properties": {
              "adGroupId": {
                "type": "string"
              },
              "asins": {
                "type": "array",
                "minItems": 1,
                "maxItems": 50,
                "items": {
                  "type": "string"
                }
              },
              "targetingExpressions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": {
                  "type": "object",
                  "required": [
                    "type"
                  ],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "CLOSE_MATCH",
                        "COMPLEMENTS",
                        "KEYWORD_BROAD_MATCH",
                        "KEYWORD_EXACT_MATCH",
                        "KEYWORD_PHRASE_MATCH",
                        "LOOSE_MATCH",
                        "SUBSTITUTES"
                      ]
                    },
                    "value": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        },
        "bidding": {
          "required": [
            "strategy"
          ],
          "properties": {
            "adjustments": {
              "type": "array",
              "minItems": 0,
              "maxItems": 2,
              "items": {
                "properties": {
                  "placementAdjustment": {
                    "type": "object",
                    "properties": {
                      "percentage": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 900
                      },
                      "predicate": {
                        "type": "string",
                        "enum": [
                          "PLACEMENT_PRODUCT_PAGE",
                          "PLACEMENT_REST_OF_SEARCH",
                          "PLACEMENT_TOP"
                        ]
                      }
                    }
                  }
                }
              }
            },
            "strategy": {
              "type": "string",
              "enum": [
                "AUTO_FOR_SALES",
                "LEGACY_FOR_SALES",
                "MANUAL",
                "RULE_BASED"
              ]
            }
          }
        },
        "endDate": {
          "type": "string"
        },
        "startDate": {
          "type": "string"
        },
        "targetingType": {
          "type": "string",
          "enum": [
            "auto",
            "manual"
          ]
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "benchmark",
        "dailyBudget",
        "specialEvents"
      ],
      "properties": {
        "benchmark": {
          "properties": {
            "benchmarkStatus": {
              "type": "string",
              "enum": [
                "failed",
                "partial",
                "success"
              ]
            },
            "values": {
              "properties": {
                "clicks": {
                  "properties": {
                    "lower": {
                      "type": "integer"
                    },
                    "upper": {
                      "type": "integer"
                    }
                  }
                },
                "conversions": {
                  "properties": {
                    "lower": {
                      "type": "integer"
                    },
                    "upper": {
                      "type": "integer"
                    }
                  }
                },
                "impressions": {
                  "properties": {
                    "lower": {
                      "type": "integer"
                    },
                    "upper": {
                      "type": "integer"
                    }
                  }
                }
              }
            }
          }
        },
        "dailyBudget": {
          "type": "number"
        },
        "recommendationId": {
          "type": "string"
        },
        "specialEvents": {
          "type": "array",
          "minItems": 0,
          "maxItems": 5,
          "items": {
            "properties": {
              "benchmark": {
                "properties": {
                  "benchmarkStatus": {
                    "type": "string",
                    "enum": [
                      "failed",
                      "partial",
                      "success"
                    ]
                  },
                  "values": {
                    "properties": {
                      "clicks": {
                        "properties": {
                          "lower": {
                            "type": "integer"
                          },
                          "upper": {
                            "type": "integer"
                          }
                        }
                      },
                      "conversions": {
                        "properties": {
                          "lower": {
                            "type": "integer"
                          },
                          "upper": {
                            "type": "integer"
                          }
                        }
                      },
                      "impressions": {
                        "properties": {
                          "lower": {
                            "type": "integer"
                          },
                          "upper": {
                            "type": "integer"
                          }
                        }
                      }
                    }
                  }
                }
              },
              "budgetModifier": {
                "type": "number"
              },
              "dailyBudget": {
                "type": "number"
              },
              "endDate": {
                "type": "string"
              },
              "eventKey": {
                "type": "string"
              },
              "eventName": {
                "type": "string"
              },
              "startDate": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.ListAssociatedBudgetRulesForSPCampaigns",
    "family": "sp-budget",
    "path": "/sp/campaigns/{campaignId}/budgetRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "associatedRules": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "ruleId"
            ],
            "properties": {
              "createdDate": {
                "type": "number",
                "format": "int64"
              },
              "lastUpdatedDate": {
                "type": "number",
                "format": "int64"
              },
              "ruleDetails": {
                "type": "object",
                "properties": {
                  "budgetIncreaseBy": {
                    "type": "object",
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "PERCENT"
                        ]
                      },
                      "value": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "duration": {
                    "type": "object",
                    "properties": {
                      "dateRangeTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "startDate"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      },
                      "eventTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "eventId"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "eventId": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 355
                  },
                  "performanceMeasureCondition": {
                    "type": "object",
                    "required": [
                      "comparisonOperator",
                      "metricName",
                      "threshold"
                    ],
                    "properties": {
                      "comparisonOperator": {
                        "type": "string",
                        "enum": [
                          "EQUAL_TO",
                          "GREATER_THAN",
                          "GREATER_THAN_OR_EQUAL_TO",
                          "LESS_THAN",
                          "LESS_THAN_OR_EQUAL_TO"
                        ]
                      },
                      "metricName": {
                        "type": "string",
                        "enum": [
                          "ACOS",
                          "CTR",
                          "CVR",
                          "ROAS"
                        ]
                      },
                      "threshold": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "daysOfWeek": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "FRIDAY",
                            "MONDAY",
                            "SATURDAY",
                            "SUNDAY",
                            "THURSDAY",
                            "TUESDAY",
                            "WEDNESDAY"
                          ]
                        }
                      },
                      "intraDaySchedule": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "properties": {
                            "endTime": {
                              "type": "string"
                            },
                            "startTime": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY"
                        ]
                      }
                    }
                  },
                  "ruleType": {
                    "type": "string",
                    "enum": [
                      "PERFORMANCE",
                      "SCHEDULE"
                    ]
                  }
                }
              },
              "ruleId": {
                "type": "string"
              },
              "ruleState": {
                "type": "string",
                "enum": [
                  "ACTIVE",
                  "PAUSED"
                ]
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "campaignId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "number",
          "format": "int64"
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp." + "GetMultiCountryThemeBased" + "BidRecommendationForAdGroup_v1",
    "family": "sp-bid",
    "path": "/sp/global/targets/bid/recommendations",
    "method": "POST",
    "contentType": "application/json",
    "accept": "application/vnd.spthemebasedglobalbidrecommendation.v1+json",
    "request": {
      "oneOf": [
        {
          "type": "object",
          "required": [
            "adGroupId",
            "campaignId",
            "recommendationType",
            "targetingExpressions"
          ],
          "properties": {
            "adGroupId": {
              "type": "string"
            },
            "campaignId": {
              "type": "string"
            },
            "countryCodes": {
              "type": "array",
              "minItems": 0,
              "maxItems": 50,
              "items": {
                "type": "string"
              }
            },
            "includeAnalysis": {
              "type": "boolean"
            },
            "recommendationType": {
              "type": "string",
              "enum": [
                "BIDS_FOR_EXISTING_AD_GROUP"
              ]
            },
            "targetingExpressions": {
              "type": "array",
              "maxItems": 100,
              "items": {
                "type": "object",
                "required": [
                  "type"
                ],
                "properties": {
                  "countryValues": {
                    "additionalProperties": {
                      "type": "string"
                    }
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "CLOSE_MATCH",
                      "COMPLEMENTS",
                      "KEYWORD_BROAD_MATCH",
                      "KEYWORD_EXACT_MATCH",
                      "KEYWORD_GROUP",
                      "KEYWORD_PHRASE_MATCH",
                      "LOOSE_MATCH",
                      "PAT_ASIN",
                      "PAT_CATEGORY",
                      "PAT_CATEGORY_REFINEMENT",
                      "SUBSTITUTES"
                    ]
                  }
                }
              }
            }
          }
        },
        {
          "type": "object",
          "required": [
            "bidding",
            "countryCodes",
            "recommendationType",
            "targetingExpressions"
          ],
          "properties": {
            "bidding": {
              "type": "object",
              "required": [
                "strategy"
              ],
              "properties": {
                "adjustments": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 3,
                  "items": {
                    "type": "object",
                    "properties": {
                      "percentage": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 900
                      },
                      "predicate": {
                        "type": "string",
                        "enum": [
                          "PLACEMENT_PRODUCT_PAGE",
                          "PLACEMENT_REST_OF_SEARCH",
                          "PLACEMENT_TOP"
                        ]
                      }
                    }
                  }
                },
                "strategy": {
                  "type": "string",
                  "enum": [
                    "AUTO_FOR_SALES",
                    "LEGACY_FOR_SALES",
                    "MANUAL",
                    "RULE_BASED"
                  ]
                }
              }
            },
            "countryCodes": {
              "type": "array",
              "minItems": 0,
              "maxItems": 50,
              "items": {
                "type": "string"
              }
            },
            "includeAnalysis": {
              "type": "boolean"
            },
            "products": {
              "type": "array",
              "minItems": 1,
              "maxItems": 50,
              "items": {
                "type": "object",
                "additionalProperties": {
                  "type": "object",
                  "properties": {
                    "asin": {
                      "type": "string"
                    },
                    "globalStoreSetting": {
                      "type": "object",
                      "properties": {
                        "catalogSourceCountryCode": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            },
            "recommendationType": {
              "type": "string",
              "enum": [
                "BIDS_FOR_NEW_AD_GROUP"
              ]
            },
            "targetingExpressions": {
              "type": "array",
              "maxItems": 100,
              "items": {
                "type": "object",
                "required": [
                  "type"
                ],
                "properties": {
                  "countryValues": {
                    "additionalProperties": {
                      "type": "string"
                    }
                  },
                  "type": {
                    "type": "string",
                    "enum": [
                      "CLOSE_MATCH",
                      "COMPLEMENTS",
                      "KEYWORD_BROAD_MATCH",
                      "KEYWORD_EXACT_MATCH",
                      "KEYWORD_GROUP",
                      "KEYWORD_PHRASE_MATCH",
                      "LOOSE_MATCH",
                      "PAT_ASIN",
                      "PAT_CATEGORY",
                      "PAT_CATEGORY_REFINEMENT",
                      "SUBSTITUTES"
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    },
    "response": {
      "type": "object",
      "required": [
        "bidRecommendations"
      ],
      "properties": {
        "bidRecommendations": {
          "type": "array",
          "minItems": 0,
          "maxItems": 2,
          "items": {
            "type": "object",
            "required": [
              "bidRecommendationsForTargetingExpressions",
              "theme"
            ],
            "properties": {
              "bidAnalysesForTargetingExpressions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "countrySuggestedBids",
                    "expression"
                  ],
                  "properties": {
                    "countryBidAnalyses": {
                      "additionalProperties": {
                        "type": "object",
                        "required": [
                          "ALL",
                          "PLACEMENT_PRODUCT_PAGE",
                          "PLACEMENT_REST_OF_SEARCH",
                          "PLACEMENT_TOP"
                        ],
                        "properties": {
                          "ALL": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 10,
                            "items": {
                              "type": "object",
                              "required": [
                                "bid",
                                "impactMetrics",
                                "type"
                              ],
                              "properties": {
                                "bid": {
                                  "type": "number",
                                  "minimum": 0,
                                  "format": "double"
                                },
                                "impactMetrics": {
                                  "type": "object",
                                  "required": [
                                    "estimatedImpressionAvg",
                                    "estimatedImpressionLower",
                                    "estimatedImpressionUpper"
                                  ],
                                  "properties": {
                                    "estimatedImpressionAvg": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionLower": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionUpper": {
                                      "type": "integer"
                                    }
                                  }
                                },
                                "type": {
                                  "type": "string",
                                  "enum": [
                                    "ALTERNATIVE",
                                    "SUGGESTED",
                                    "SUGGESTED_LOWER",
                                    "SUGGESTED_UPPER"
                                  ]
                                }
                              }
                            }
                          },
                          "PLACEMENT_PRODUCT_PAGE": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 10,
                            "items": {
                              "type": "object",
                              "required": [
                                "bid",
                                "impactMetrics",
                                "type"
                              ],
                              "properties": {
                                "bid": {
                                  "type": "number",
                                  "minimum": 0,
                                  "format": "double"
                                },
                                "impactMetrics": {
                                  "type": "object",
                                  "required": [
                                    "estimatedImpressionAvg",
                                    "estimatedImpressionLower",
                                    "estimatedImpressionUpper"
                                  ],
                                  "properties": {
                                    "estimatedImpressionAvg": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionLower": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionUpper": {
                                      "type": "integer"
                                    }
                                  }
                                },
                                "type": {
                                  "type": "string",
                                  "enum": [
                                    "ALTERNATIVE",
                                    "SUGGESTED",
                                    "SUGGESTED_LOWER",
                                    "SUGGESTED_UPPER"
                                  ]
                                }
                              }
                            }
                          },
                          "PLACEMENT_REST_OF_SEARCH": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 10,
                            "items": {
                              "type": "object",
                              "required": [
                                "bid",
                                "impactMetrics",
                                "type"
                              ],
                              "properties": {
                                "bid": {
                                  "type": "number",
                                  "minimum": 0,
                                  "format": "double"
                                },
                                "impactMetrics": {
                                  "type": "object",
                                  "required": [
                                    "estimatedImpressionAvg",
                                    "estimatedImpressionLower",
                                    "estimatedImpressionUpper"
                                  ],
                                  "properties": {
                                    "estimatedImpressionAvg": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionLower": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionUpper": {
                                      "type": "integer"
                                    }
                                  }
                                },
                                "type": {
                                  "type": "string",
                                  "enum": [
                                    "ALTERNATIVE",
                                    "SUGGESTED",
                                    "SUGGESTED_LOWER",
                                    "SUGGESTED_UPPER"
                                  ]
                                }
                              }
                            }
                          },
                          "PLACEMENT_TOP": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 10,
                            "items": {
                              "type": "object",
                              "required": [
                                "bid",
                                "impactMetrics",
                                "type"
                              ],
                              "properties": {
                                "bid": {
                                  "type": "number",
                                  "minimum": 0,
                                  "format": "double"
                                },
                                "impactMetrics": {
                                  "type": "object",
                                  "required": [
                                    "estimatedImpressionAvg",
                                    "estimatedImpressionLower",
                                    "estimatedImpressionUpper"
                                  ],
                                  "properties": {
                                    "estimatedImpressionAvg": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionLower": {
                                      "type": "integer"
                                    },
                                    "estimatedImpressionUpper": {
                                      "type": "integer"
                                    }
                                  }
                                },
                                "type": {
                                  "type": "string",
                                  "enum": [
                                    "ALTERNATIVE",
                                    "SUGGESTED",
                                    "SUGGESTED_LOWER",
                                    "SUGGESTED_UPPER"
                                  ]
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "expression": {
                      "type": "object",
                      "required": [
                        "type"
                      ],
                      "properties": {
                        "countryValues": {
                          "additionalProperties": {
                            "type": "string"
                          }
                        },
                        "type": {
                          "type": "string",
                          "enum": [
                            "CLOSE_MATCH",
                            "COMPLEMENTS",
                            "KEYWORD_BROAD_MATCH",
                            "KEYWORD_EXACT_MATCH",
                            "KEYWORD_GROUP",
                            "KEYWORD_PHRASE_MATCH",
                            "LOOSE_MATCH",
                            "PAT_ASIN",
                            "PAT_CATEGORY",
                            "PAT_CATEGORY_REFINEMENT",
                            "SUBSTITUTES"
                          ]
                        }
                      }
                    }
                  }
                }
              },
              "bidRecommendationsForTargetingExpressions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "countrySuggestedBids",
                    "expression"
                  ],
                  "properties": {
                    "countrySuggestedBids": {
                      "additionalProperties": {
                        "type": "array",
                        "maxItems": 3,
                        "items": {
                          "type": "number",
                          "minimum": 0,
                          "format": "double"
                        }
                      }
                    },
                    "expression": {
                      "type": "object",
                      "required": [
                        "type"
                      ],
                      "properties": {
                        "countryValues": {
                          "additionalProperties": {
                            "type": "string"
                          }
                        },
                        "type": {
                          "type": "string",
                          "enum": [
                            "CLOSE_MATCH",
                            "COMPLEMENTS",
                            "KEYWORD_BROAD_MATCH",
                            "KEYWORD_EXACT_MATCH",
                            "KEYWORD_GROUP",
                            "KEYWORD_PHRASE_MATCH",
                            "LOOSE_MATCH",
                            "PAT_ASIN",
                            "PAT_CATEGORY",
                            "PAT_CATEGORY_REFINEMENT",
                            "SUBSTITUTES"
                          ]
                        }
                      }
                    }
                  }
                }
              },
              "theme": {
                "type": "string",
                "enum": [
                  "BFCM_HOLIDAY",
                  "CONVERSION_OPPORTUNITIES",
                  "FALL_PRIME_DEAL_EVENT",
                  "PRIME_DAY"
                ]
              }
            }
          }
        },
        "errors": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "code": {
                "type": "string"
              },
              "countryCodes": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              },
              "message": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getGlobalRankedKeywordRecommendation",
    "family": "sp-research",
    "path": "/sp/global/targets/keywords/recommendations/list",
    "method": "POST",
    "contentType": "application/vnd.spkeywordsrecommendation.v5+json",
    "accept": "application/vnd.spkeywordsrecommendation.v5+json",
    "request": {
      "oneOf": [
        {
          "required": [
            "recommendationType"
          ],
          "allOf": [
            {
              "allOf": [
                {
                  "properties": {
                    "locale": {
                      "type": "string",
                      "enum": [
                        "ar_EG",
                        "de_DE",
                        "en_AE",
                        "en_AU",
                        "en_CA",
                        "en_GB",
                        "en_IN",
                        "en_SA",
                        "en_SG",
                        "en_US",
                        "es_ES",
                        "es_MX",
                        "fr_FR",
                        "it_IT",
                        "ja_JP",
                        "nl_NL",
                        "pl_PL",
                        "pt_BR",
                        "sv_SE",
                        "tr_TR",
                        "zh_CN"
                      ]
                    },
                    "maxRecommendations": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 200
                    },
                    "sortDimension": {
                      "type": "string",
                      "enum": [
                        "CLICKS",
                        "CONVERSIONS",
                        "DEFAULT"
                      ]
                    }
                  }
                }
              ],
              "properties": {
                "biddingStrategy": {
                  "type": "string",
                  "enum": [
                    "AUTO_FOR_SALES",
                    "LEGACY_FOR_SALES",
                    "MANUAL",
                    "RULE_BASED"
                  ]
                },
                "bidsEnabled": {
                  "type": "boolean"
                },
                "recommendationType": {
                  "type": "string",
                  "enum": [
                    "KEYWORDS_FOR_ASINS"
                  ]
                }
              }
            }
          ],
          "properties": {
            "products": {
              "type": "array",
              "minItems": 0,
              "maxItems": 50,
              "items": {
                "type": "object",
                "additionalProperties": {
                  "type": "object",
                  "properties": {
                    "asin": {
                      "type": "string"
                    },
                    "globalStoreSetting": {
                      "type": "object",
                      "properties": {
                        "catalogSourceCountryCode": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            },
            "targets": {
              "type": "array",
              "minItems": 0,
              "maxItems": 100,
              "items": {
                "type": "object",
                "properties": {
                  "countryKeywords": {
                    "type": "object",
                    "additionalProperties": {
                      "properties": {
                        "bid": {
                          "type": "number",
                          "format": "double"
                        },
                        "userSelectedKeyword": {
                          "type": "boolean"
                        },
                        "value": {
                          "type": "string"
                        }
                      }
                    }
                  },
                  "matchType": {
                    "type": "string",
                    "enum": [
                      "BROAD",
                      "EXACT",
                      "PHRASE"
                    ]
                  }
                }
              }
            }
          }
        },
        {
          "required": [
            "adGroupId",
            "campaignId",
            "recommendationType"
          ],
          "allOf": [
            {
              "allOf": [
                {
                  "properties": {
                    "locale": {
                      "type": "string",
                      "enum": [
                        "ar_EG",
                        "de_DE",
                        "en_AE",
                        "en_AU",
                        "en_CA",
                        "en_GB",
                        "en_IN",
                        "en_SA",
                        "en_SG",
                        "en_US",
                        "es_ES",
                        "es_MX",
                        "fr_FR",
                        "it_IT",
                        "ja_JP",
                        "nl_NL",
                        "pl_PL",
                        "pt_BR",
                        "sv_SE",
                        "tr_TR",
                        "zh_CN"
                      ]
                    },
                    "maxRecommendations": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 200
                    },
                    "sortDimension": {
                      "type": "string",
                      "enum": [
                        "CLICKS",
                        "CONVERSIONS",
                        "DEFAULT"
                      ]
                    }
                  }
                }
              ],
              "properties": {
                "adGroupId": {
                  "type": "string"
                },
                "bidsEnabled": {
                  "type": "boolean"
                },
                "campaignId": {
                  "type": "string"
                },
                "recommendationType": {
                  "type": "string",
                  "enum": [
                    "KEYWORDS_FOR_ADGROUP"
                  ]
                }
              }
            }
          ],
          "properties": {
            "targets": {
              "type": "array",
              "minItems": 0,
              "maxItems": 100,
              "items": {
                "type": "object",
                "properties": {
                  "countryKeywords": {
                    "type": "object",
                    "additionalProperties": {
                      "properties": {
                        "bid": {
                          "type": "number",
                          "format": "double"
                        },
                        "userSelectedKeyword": {
                          "type": "boolean"
                        },
                        "value": {
                          "type": "string"
                        }
                      }
                    }
                  },
                  "matchType": {
                    "type": "string",
                    "enum": [
                      "BROAD",
                      "EXACT",
                      "PHRASE"
                    ]
                  }
                }
              }
            }
          }
        }
      ]
    },
    "response": {
      "type": "object",
      "properties": {
        "countryCodes": {
          "type": "object",
          "additionalProperties": {
            "type": "object",
            "properties": {
              "impactMetrics": {
                "type": "array",
                "minItems": 0,
                "maxItems": 5,
                "items": {
                  "type": "object",
                  "nullable": true,
                  "properties": {
                    "clicks": {
                      "type": "object",
                      "nullable": true,
                      "properties": {
                        "values": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "lower": {
                                "type": "integer"
                              },
                              "upper": {
                                "type": "integer"
                              }
                            }
                          }
                        }
                      }
                    },
                    "orders": {
                      "type": "object",
                      "nullable": true,
                      "properties": {
                        "values": {
                          "type": "array",
                          "items": {
                            "type": "object",
                            "properties": {
                              "lower": {
                                "type": "integer"
                              },
                              "upper": {
                                "type": "integer"
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "keywordTargetList": {
                "type": "array",
                "minItems": 0,
                "maxItems": 200,
                "items": {
                  "type": "object",
                  "properties": {
                    "bidInfo": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 15,
                      "items": {
                        "allOf": [
                          {
                            "type": "object",
                            "properties": {
                              "bid": {
                                "type": "number",
                                "format": "Double"
                              },
                              "matchType": {
                                "type": "string",
                                "enum": [
                                  "BROAD",
                                  "EXACT",
                                  "PHRASE"
                                ]
                              },
                              "rank": {
                                "type": "number"
                              },
                              "suggestedBid": {
                                "properties": {
                                  "rangeEnd": {
                                    "type": "number",
                                    "format": "double"
                                  },
                                  "rangeStart": {
                                    "type": "number",
                                    "format": "double"
                                  },
                                  "suggested": {
                                    "type": "number",
                                    "format": "double"
                                  }
                                }
                              },
                              "theme": {
                                "type": "string"
                              }
                            }
                          }
                        ]
                      }
                    },
                    "keyword": {
                      "type": "string"
                    },
                    "recId": {
                      "type": "string"
                    },
                    "searchTermImpressionRank": {
                      "type": "number"
                    },
                    "searchTermImpressionShare": {
                      "type": "number",
                      "format": "Double"
                    },
                    "translation": {
                      "type": "string"
                    },
                    "userSelectedKeyword": {
                      "type": "boolean"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getNegativeBrands",
    "family": "sp-research",
    "path": "/sp/negativeTargets/brands/recommendations",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.spproducttargetingresponse.v3+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.searchBrands",
    "family": "sp-research",
    "path": "/sp/negativeTargets/brands/search",
    "method": "POST",
    "contentType": "application/vnd.spproducttargeting.v3+json",
    "accept": "application/vnd.spproducttargetingresponse.v3+json",
    "request": {
      "type": "object",
      "required": [
        "keyword"
      ],
      "properties": {
        "keyword": {
          "type": "string"
        }
      }
    },
    "response": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetOptimizationRuleEligibility",
    "family": "rule-evidence",
    "path": "/sp/rules/campaignOptimization/eligibility",
    "method": "POST",
    "contentType": "application/vnd.optimizationrules.v1+json",
    "accept": "application/vnd.optimizationrules.v1+json",
    "request": {
      "type": "object",
      "required": [
        "campaignIds"
      ],
      "properties": {
        "campaignIds": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        },
        "requirePerformanceMetrics": {
          "type": "boolean"
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "CampaignOptimizationRecommendations": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "object",
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "performanceMetrics": {
                "type": "object",
                "properties": {
                  "roas": {
                    "type": "number",
                    "format": "double"
                  }
                }
              },
              "performanceMetricsExists": {
                "type": "boolean"
              }
            }
          }
        },
        "CampaignOptimizationRecommendationsError": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "object",
            "properties": {
              "Error": {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "details": {
                    "type": "string"
                  }
                }
              },
              "campaignId": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetRuleNotification",
    "family": "rule-evidence",
    "path": "/sp/rules/campaignOptimization/state",
    "method": "POST",
    "contentType": "application/vnd.optimizationrules.v1+json",
    "accept": "application/vnd.optimizationrules.v1+json",
    "request": {
      "type": "object",
      "required": [
        "campaignIds"
      ],
      "properties": {
        "campaignIds": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "CampaignOptimizationNotifications": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "object",
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "campaignOptimizationId": {
                "type": "string",
                "maxLength": 355
              },
              "notificationString": {
                "type": "string"
              },
              "ruleState": {
                "type": "string",
                "enum": [
                  "DISABLED",
                  "ENABLED"
                ]
              }
            }
          }
        },
        "CampaignOptimizationRecommendationsError": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "object",
            "properties": {
              "Error": {
                "type": "object",
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "details": {
                    "type": "string"
                  }
                }
              },
              "campaignId": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetCampaignOptimizationRule",
    "family": "rule-evidence",
    "path": "/sp/rules/campaignOptimization/{campaignOptimizationId}",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.optimizationrules.v1+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "CampaignOptimizationRule": {
          "type": "object",
          "required": [
            "campaignOptimizationId"
          ],
          "properties": {
            "campaignIds": {
              "type": "array",
              "maxItems": 100,
              "items": {
                "type": "string"
              }
            },
            "campaignOptimizationId": {
              "type": "string",
              "maxLength": 355
            },
            "createdDate": {
              "type": "string"
            },
            "recurrence": {
              "type": "string",
              "enum": [
                "DAILY"
              ]
            },
            "ruleAction": {
              "type": "string",
              "enum": [
                "ADOPT"
              ]
            },
            "ruleCondition": {
              "type": "array",
              "maxItems": 3,
              "items": {
                "type": "object",
                "required": [
                  "comparisonOperator",
                  "metricName",
                  "threshold"
                ],
                "properties": {
                  "comparisonOperator": {
                    "type": "string",
                    "enum": [
                      "EQUAL_TO",
                      "GREATER_THAN",
                      "GREATER_THAN_OR_EQUAL_TO",
                      "LESS_THAN",
                      "LESS_THAN_OR_EQUAL_TO"
                    ]
                  },
                  "metricName": {
                    "type": "string",
                    "enum": [
                      "AVERAGE_BID",
                      "ROAS"
                    ]
                  },
                  "threshold": {
                    "type": "number",
                    "format": "double"
                  }
                }
              }
            },
            "ruleName": {
              "type": "string",
              "maxLength": 355
            },
            "ruleStatus": {
              "type": "string",
              "enum": [
                "ACTIVE",
                "ARCHIVED"
              ]
            },
            "ruleType": {
              "type": "string",
              "enum": [
                "BID",
                "KEYWORD",
                "PRODUCT"
              ]
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "campaignOptimizationId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.SearchOptimizationRules",
    "family": "rule-evidence",
    "path": "/sp/rules/optimization/search",
    "method": "POST",
    "contentType": "application/vnd.spoptimizationrules.v1+json",
    "accept": "application/vnd.spoptimizationrules.v1+json",
    "request": {
      "type": "object",
      "properties": {
        "campaignFilter": {
          "type": "object",
          "properties": {
            "campaignId": {
              "type": "object",
              "properties": {
                "filterType": {
                  "type": "string",
                  "enum": [
                    "BROAD_MATCH",
                    "EXACT_MATCH"
                  ]
                },
                "values": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 100,
                  "items": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        },
        "optimizationRuleFilter": {
          "type": "object",
          "properties": {
            "optimizationRuleId": {
              "type": "object",
              "properties": {
                "filterType": {
                  "type": "string",
                  "enum": [
                    "BROAD_MATCH",
                    "EXACT_MATCH"
                  ]
                },
                "values": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 100,
                  "items": {
                    "type": "string"
                  }
                }
              }
            },
            "ruleCategory": {
              "type": "object",
              "properties": {
                "filterType": {
                  "type": "string",
                  "enum": [
                    "BROAD_MATCH",
                    "EXACT_MATCH"
                  ]
                },
                "values": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 100,
                  "items": {
                    "type": "string"
                  }
                }
              }
            },
            "ruleSubCategory": {
              "type": "object",
              "properties": {
                "filterType": {
                  "type": "string",
                  "enum": [
                    "BROAD_MATCH",
                    "EXACT_MATCH"
                  ]
                },
                "values": {
                  "type": "array",
                  "minItems": 1,
                  "maxItems": 100,
                  "items": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        "pageSize": {
          "type": "number"
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "code": {
          "type": "string"
        },
        "nextToken": {
          "type": "string"
        },
        "optimizationRules": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "allOf": [
              {
                "type": "object",
                "required": [
                  "action",
                  "recurrence",
                  "ruleCategory",
                  "ruleSubCategory"
                ],
                "properties": {
                  "action": {
                    "type": "object",
                    "required": [
                      "actionDetails",
                      "actionType"
                    ],
                    "properties": {
                      "actionDetails": {
                        "type": "object",
                        "required": [
                          "actionOperator",
                          "actionUnit",
                          "value"
                        ],
                        "properties": {
                          "actionOperator": {
                            "type": "string",
                            "enum": [
                              "INCREMENT"
                            ]
                          },
                          "actionUnit": {
                            "type": "string",
                            "enum": [
                              "PERCENT"
                            ]
                          },
                          "value": {
                            "type": "number",
                            "format": "double"
                          }
                        }
                      },
                      "actionType": {
                        "type": "string",
                        "enum": [
                          "ADOPT"
                        ]
                      }
                    }
                  },
                  "conditions": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 1,
                    "items": {
                      "type": "object",
                      "properties": {
                        "attributeName": {
                          "type": "string",
                          "enum": [
                            "ROAS"
                          ]
                        },
                        "criteria": {
                          "oneOf": [
                            {
                              "type": "object",
                              "required": [
                                "maxValue",
                                "minValue"
                              ],
                              "properties": {
                                "maxValue": {
                                  "type": "number",
                                  "format": "double"
                                },
                                "minValue": {
                                  "type": "number",
                                  "format": "double"
                                }
                              }
                            },
                            {
                              "type": "object",
                              "required": [
                                "comparisonOperator",
                                "value"
                              ],
                              "properties": {
                                "comparisonOperator": {
                                  "type": "string",
                                  "enum": [
                                    "EQUAL_TO",
                                    "GREATER_THAN",
                                    "GREATER_THAN_OR_EQUAL_TO",
                                    "LESS_THAN",
                                    "LESS_THAN_OR_EQUAL_TO"
                                  ]
                                },
                                "value": {
                                  "type": "number",
                                  "format": "double"
                                }
                              }
                            }
                          ]
                        }
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "required": [
                      "duration",
                      "type"
                    ],
                    "properties": {
                      "daysOfWeek": {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": 7,
                        "items": {
                          "type": "string",
                          "enum": [
                            "FRIDAY",
                            "MONDAY",
                            "SATURDAY",
                            "SUNDAY",
                            "THURSDAY",
                            "TUESDAY",
                            "WEDNESDAY"
                          ]
                        }
                      },
                      "duration": {
                        "type": "object",
                        "properties": {
                          "endTime": {
                            "type": "string"
                          },
                          "eventId": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startTime": {
                            "type": "string"
                          }
                        }
                      },
                      "timesOfDay": {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "required": [
                            "endTime",
                            "startTime"
                          ],
                          "properties": {
                            "endTime": {
                              "type": "string"
                            },
                            "startTime": {
                              "type": "string"
                            }
                          }
                        }
                      },
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY",
                          "WEEKLY"
                        ]
                      }
                    }
                  },
                  "ruleCategory": {
                    "type": "string",
                    "enum": [
                      "BID"
                    ]
                  },
                  "ruleName": {
                    "type": "string"
                  },
                  "ruleSubCategory": {
                    "type": "string",
                    "enum": [
                      "SCHEDULE"
                    ]
                  },
                  "status": {
                    "type": "string",
                    "enum": [
                      "ENABLED",
                      "ENDED",
                      "PAUSED",
                      "SCHEDULED"
                    ]
                  }
                }
              },
              {
                "type": "object",
                "properties": {
                  "optimizationRuleId": {
                    "type": "string"
                  }
                }
              }
            ]
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.ListTargetPromotionGroups",
    "family": "sp-research",
    "path": "/sp/targetPromotionGroups/list",
    "method": "POST",
    "contentType": "application/vnd.sptargetpromotiongroup.v1+json",
    "accept": "application/vnd.sptargetpromotiongroup.v1+json",
    "request": {
      "type": "object",
      "properties": {
        "adGroupIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        },
        "maxResults": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000,
          "format": "int32"
        },
        "nextToken": {
          "type": "string"
        },
        "targetPromotionGroupIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "targetPromotionGroups": {
          "type": "array",
          "minItems": 0,
          "maxItems": 1000,
          "items": {
            "type": "object",
            "properties": {
              "autoTargetingCampaignAdGroupId": {
                "type": "string"
              },
              "autoTargetingCampaignAdIds": {
                "type": "array",
                "minItems": 0,
                "maxItems": 1000,
                "items": {
                  "type": "string"
                }
              },
              "keywordCampaignAdGroupIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1,
                "items": {
                  "type": "string"
                }
              },
              "productCampaignAdGroupIds": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1,
                "items": {
                  "type": "string"
                }
              },
              "state": {
                "type": "string"
              },
              "targetPromotionGroupId": {
                "type": "string"
              },
              "targetPromotionGroupName": {
                "type": "string"
              }
            }
          }
        },
        "totalResults": {
          "type": "integer",
          "format": "int64"
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetTargetPromotionGroupsRecommendations",
    "family": "sp-research",
    "path": "/sp/targetPromotionGroups/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spTargetPromotionGroupsRecommendations.v1+json",
    "accept": "application/vnd.spTargetPromotionGroupsRecommendations.v1+json",
    "request": {
      "type": "object",
      "properties": {
        "adGroupIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        },
        "adIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        },
        "campaignIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        },
        "maxResults": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "targets",
        "totalResults"
      ],
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "targets": {
          "type": "array",
          "minItems": 0,
          "maxItems": 1000,
          "items": {
            "type": "object",
            "properties": {
              "adAsin": {
                "type": "string"
              },
              "adGroupId": {
                "type": "string"
              },
              "adId": {
                "type": "string"
              },
              "campaignId": {
                "type": "string"
              },
              "recommendationReasons": {
                "type": "array",
                "minItems": 0,
                "maxItems": 1000,
                "items": {
                  "type": "object",
                  "properties": {
                    "data": {
                      "type": "string"
                    },
                    "reason": {
                      "type": "string"
                    }
                  }
                }
              },
              "recommendedTarget": {
                "type": "string"
              },
              "targetType": {
                "type": "string",
                "enum": [
                  "ASIN",
                  "KEYWORD"
                ]
              }
            }
          }
        },
        "totalResults": {
          "type": "integer"
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.ListTargetPromotionGroupTargets",
    "family": "sp-research",
    "path": "/sp/targetPromotionGroups/targets/list",
    "method": "POST",
    "contentType": "application/vnd.sptargetpromotiongrouptarget.v1+json",
    "accept": "application/vnd.sptargetpromotiongrouptarget.v1+json",
    "request": {
      "type": "object",
      "properties": {
        "adGroupIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        },
        "maxResults": {
          "type": "integer",
          "minimum": 1,
          "maximum": 1000,
          "format": "int32"
        },
        "nextToken": {
          "type": "string"
        },
        "targetPromotionGroupIdFilter": {
          "type": "object",
          "required": [
            "include"
          ],
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "targets": {
          "type": "array",
          "minItems": 0,
          "maxItems": 1000,
          "items": {
            "type": "object",
            "properties": {
              "expressionType": {
                "type": "string"
              },
              "manualTargetingAdGroupId": {
                "type": "string"
              },
              "target": {
                "type": "string"
              },
              "targetId": {
                "type": "string"
              },
              "targetPromotionGroupId": {
                "type": "string"
              }
            }
          }
        },
        "totalResults": {
          "type": "integer",
          "format": "int64"
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getKeywordGroupRecommendations",
    "family": "sp-research",
    "path": "/sp/targeting/recommendations/keywordGroups",
    "method": "POST",
    "contentType": "application/vnd.spkeywordgroupsrecommendations.v1.0+json",
    "accept": "application/vnd.spkeywordgroupsrecommendations.v1.0+json",
    "request": {
      "type": "object",
      "required": [
        "asins"
      ],
      "properties": {
        "asins": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1000,
          "items": {
            "type": "string",
            "maxLength": 32
          }
        },
        "countryCode": {
          "type": "string"
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "keywordGroups"
      ],
      "properties": {
        "countryCode": {
          "type": "string"
        },
        "keywordGroups": {
          "type": "array",
          "minItems": 0,
          "maxItems": 50,
          "items": {
            "type": "object",
            "required": [
              "id",
              "text"
            ],
            "properties": {
              "description": {
                "type": "string"
              },
              "id": {
                "type": "string"
              },
              "impactSummary": {
                "type": "string"
              },
              "sampleKeywords": {
                "type": "array",
                "minItems": 0,
                "maxItems": 10,
                "items": {
                  "type": "string"
                }
              },
              "text": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.GetThemeBasedBidRecommendationForAdGroup_v1",
    "family": "sp-bid",
    "path": "/sp/targets/bid/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spthemebasedbidrecommendation.v3+json",
    "accept": "application/vnd.spthemebasedbidrecommendation.v3+json",
    "request": {
      "oneOf": [
        {
          "type": "object",
          "required": [
            "adGroupId",
            "campaignId",
            "recommendationType",
            "targetingExpressions"
          ],
          "properties": {
            "adGroupId": {
              "type": "string"
            },
            "campaignId": {
              "type": "string"
            },
            "recommendationType": {
              "type": "string",
              "enum": [
                "BIDS_FOR_EXISTING_AD_GROUP"
              ]
            },
            "targetingExpressions": {
              "type": "array",
              "maxItems": 100,
              "items": {
                "type": "object",
                "required": [
                  "type"
                ],
                "properties": {
                  "type": {
                    "type": "string",
                    "enum": [
                      "CLOSE_MATCH",
                      "COMPLEMENTS",
                      "KEYWORD_BROAD_MATCH",
                      "KEYWORD_EXACT_MATCH",
                      "KEYWORD_PHRASE_MATCH",
                      "LOOSE_MATCH",
                      "SUBSTITUTES"
                    ]
                  },
                  "value": {
                    "type": "string"
                  }
                }
              }
            }
          }
        },
        {
          "type": "object",
          "required": [
            "asins",
            "bidding",
            "recommendationType",
            "targetingExpressions"
          ],
          "properties": {
            "asins": {
              "type": "array",
              "maxItems": 50,
              "items": {
                "type": "string"
              }
            },
            "bidding": {
              "type": "object",
              "required": [
                "strategy"
              ],
              "properties": {
                "adjustments": {
                  "type": "array",
                  "maxItems": 3,
                  "items": {
                    "type": "object",
                    "properties": {
                      "percentage": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 900
                      },
                      "predicate": {
                        "type": "string",
                        "enum": [
                          "PLACEMENT_PRODUCT_PAGE",
                          "PLACEMENT_REST_OF_SEARCH",
                          "PLACEMENT_TOP"
                        ]
                      }
                    }
                  }
                },
                "strategy": {
                  "type": "string",
                  "enum": [
                    "AUTO_FOR_SALES",
                    "LEGACY_FOR_SALES",
                    "MANUAL",
                    "RULE_BASED"
                  ]
                }
              }
            },
            "recommendationType": {
              "type": "string",
              "enum": [
                "BIDS_FOR_NEW_AD_GROUP"
              ]
            },
            "targetingExpressions": {
              "type": "array",
              "maxItems": 100,
              "items": {
                "type": "object",
                "required": [
                  "type"
                ],
                "properties": {
                  "type": {
                    "type": "string",
                    "enum": [
                      "CLOSE_MATCH",
                      "COMPLEMENTS",
                      "KEYWORD_BROAD_MATCH",
                      "KEYWORD_EXACT_MATCH",
                      "KEYWORD_PHRASE_MATCH",
                      "LOOSE_MATCH",
                      "SUBSTITUTES"
                    ]
                  },
                  "value": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      ]
    },
    "response": {
      "type": "object",
      "required": [
        "bidRecommendations"
      ],
      "properties": {
        "bidRecommendations": {
          "type": "array",
          "maxItems": 2,
          "items": {
            "type": "object",
            "required": [
              "bidRecommendationsForTargetingExpressions",
              "theme"
            ],
            "properties": {
              "bidRecommendationsForTargetingExpressions": {
                "type": "array",
                "items": {
                  "type": "object",
                  "required": [
                    "bidValues",
                    "targetingExpression"
                  ],
                  "properties": {
                    "bidValues": {
                      "type": "array",
                      "maxItems": 3,
                      "items": {
                        "type": "object",
                        "required": [
                          "suggestedBid"
                        ],
                        "properties": {
                          "suggestedBid": {
                            "type": "number",
                            "minimum": 0,
                            "format": "double"
                          }
                        }
                      }
                    },
                    "targetingExpression": {
                      "type": "object",
                      "required": [
                        "type"
                      ],
                      "properties": {
                        "type": {
                          "type": "string",
                          "enum": [
                            "CLOSE_MATCH",
                            "COMPLEMENTS",
                            "KEYWORD_BROAD_MATCH",
                            "KEYWORD_EXACT_MATCH",
                            "KEYWORD_PHRASE_MATCH",
                            "LOOSE_MATCH",
                            "SUBSTITUTES"
                          ]
                        },
                        "value": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              },
              "impactMetrics": {
                "type": "object",
                "nullable": true,
                "properties": {
                  "clicks": {
                    "type": "object",
                    "nullable": true,
                    "properties": {
                      "values": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "lower": {
                              "type": "integer"
                            },
                            "upper": {
                              "type": "integer"
                            }
                          }
                        }
                      }
                    }
                  },
                  "orders": {
                    "type": "object",
                    "nullable": true,
                    "properties": {
                      "values": {
                        "type": "array",
                        "items": {
                          "type": "object",
                          "properties": {
                            "lower": {
                              "type": "integer"
                            },
                            "upper": {
                              "type": "integer"
                            }
                          }
                        }
                      }
                    }
                  }
                }
              },
              "theme": {
                "type": "string",
                "enum": [
                  "BFCM_HOLIDAY",
                  "CONVERSION_OPPORTUNITIES",
                  "FALL_PRIME_DEAL_EVENT",
                  "PRIME_DAY"
                ]
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getTargetableCategories",
    "family": "sp-research",
    "path": "/sp/targets/categories",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.spproducttargetingresponse.v3+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "categoryTree": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "locale",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string",
          "enum": [
            "ar_AE",
            "de_DE",
            "en_AE",
            "en_AU",
            "en_CA",
            "en_GB",
            "en_IN",
            "en_SG",
            "en_US",
            "es_ES",
            "es_MX",
            "fr_CA",
            "fr_FR",
            "hi_IN",
            "it_IT",
            "ja_JP",
            "ko_KR",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "sv_SE",
            "ta_IN",
            "th_TH",
            "tr_TR",
            "vi_VN",
            "zh_CN"
          ]
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getCategoryRecommendationsForASINs",
    "family": "sp-research",
    "path": "/sp/targets/categories/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spproducttargeting.v3+json",
    "accept": "application/vnd.spproducttargetingresponse.v3+json",
    "request": {
      "type": "object",
      "properties": {
        "asins": {
          "type": "array",
          "maxItems": 10000,
          "items": {
            "type": "string"
          }
        },
        "includeAncestor": {
          "type": "boolean"
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "categories": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "canBeTargeted": {
                "type": "boolean"
              },
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "parent": {
                "type": "string"
              },
              "path": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "locale",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string",
          "enum": [
            "ar_AE",
            "de_DE",
            "en_AE",
            "en_AU",
            "en_CA",
            "en_GB",
            "en_IN",
            "en_SG",
            "en_US",
            "es_ES",
            "es_MX",
            "fr_CA",
            "fr_FR",
            "hi_IN",
            "it_IT",
            "ja_JP",
            "ko_KR",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "sv_SE",
            "ta_IN",
            "th_TH",
            "tr_TR",
            "vi_VN",
            "zh_CN"
          ]
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getRefinementsForCategory",
    "family": "sp-research",
    "path": "/sp/targets/category/{categoryId}/refinements",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.spproducttargetingresponse.v3+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "ageRanges": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "brands": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "genres": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "categoryId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "locale",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string",
          "enum": [
            "ar_AE",
            "de_DE",
            "en_AE",
            "en_AU",
            "en_CA",
            "en_GB",
            "en_IN",
            "en_SG",
            "en_US",
            "es_ES",
            "es_MX",
            "fr_CA",
            "fr_FR",
            "hi_IN",
            "it_IT",
            "ja_JP",
            "ko_KR",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "sv_SE",
            "ta_IN",
            "th_TH",
            "tr_TR",
            "vi_VN",
            "zh_CN"
          ]
        }
      }
    ],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getRankedKeywordRecommendation",
    "family": "sp-research",
    "path": "/sp/targets/keywords/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spkeywordsrecommendation.v3+json",
    "accept": "application/vnd.spkeywordsrecommendation.v3+json",
    "request": {
      "oneOf": [
        {
          "required": [
            "adGroupId",
            "campaignId",
            "recommendationType"
          ],
          "allOf": [
            {
              "allOf": [
                {
                  "properties": {
                    "locale": {
                      "type": "string",
                      "enum": [
                        "ar_EG",
                        "de_DE",
                        "en_AE",
                        "en_AU",
                        "en_CA",
                        "en_GB",
                        "en_IN",
                        "en_SA",
                        "en_SG",
                        "en_US",
                        "es_ES",
                        "es_MX",
                        "fr_FR",
                        "it_IT",
                        "ja_JP",
                        "nl_NL",
                        "pl_PL",
                        "pt_BR",
                        "sv_SE",
                        "tr_TR",
                        "zh_CN"
                      ]
                    },
                    "maxRecommendations": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 200
                    },
                    "sortDimension": {
                      "type": "string",
                      "enum": [
                        "CLICKS",
                        "CONVERSIONS",
                        "DEFAULT"
                      ]
                    }
                  }
                }
              ],
              "properties": {
                "targets": {
                  "type": "array",
                  "minItems": 0,
                  "maxItems": 100,
                  "items": {
                    "allOf": [
                      {
                        "properties": {
                          "bid": {
                            "type": "number",
                            "format": "double"
                          },
                          "keyword": {
                            "type": "string"
                          },
                          "matchType": {
                            "type": "string",
                            "enum": [
                              "BROAD",
                              "EXACT",
                              "PHRASE"
                            ]
                          },
                          "userSelectedKeyword": {
                            "type": "boolean"
                          }
                        }
                      }
                    ]
                  }
                }
              }
            }
          ],
          "properties": {
            "adGroupId": {
              "type": "string"
            },
            "campaignId": {
              "type": "string"
            },
            "recommendationType": {
              "type": "string",
              "enum": [
                "KEYWORDS_FOR_ADGROUP"
              ]
            }
          }
        },
        {
          "required": [
            "asins",
            "recommendationType"
          ],
          "allOf": [
            {
              "allOf": [
                {
                  "properties": {
                    "locale": {
                      "type": "string",
                      "enum": [
                        "ar_EG",
                        "de_DE",
                        "en_AE",
                        "en_AU",
                        "en_CA",
                        "en_GB",
                        "en_IN",
                        "en_SA",
                        "en_SG",
                        "en_US",
                        "es_ES",
                        "es_MX",
                        "fr_FR",
                        "it_IT",
                        "ja_JP",
                        "nl_NL",
                        "pl_PL",
                        "pt_BR",
                        "sv_SE",
                        "tr_TR",
                        "zh_CN"
                      ]
                    },
                    "maxRecommendations": {
                      "type": "number",
                      "minimum": 0,
                      "maximum": 200
                    },
                    "sortDimension": {
                      "type": "string",
                      "enum": [
                        "CLICKS",
                        "CONVERSIONS",
                        "DEFAULT"
                      ]
                    }
                  }
                }
              ],
              "properties": {
                "targets": {
                  "type": "array",
                  "minItems": 0,
                  "maxItems": 100,
                  "items": {
                    "allOf": [
                      {
                        "properties": {
                          "bid": {
                            "type": "number",
                            "format": "double"
                          },
                          "keyword": {
                            "type": "string"
                          },
                          "matchType": {
                            "type": "string",
                            "enum": [
                              "BROAD",
                              "EXACT",
                              "PHRASE"
                            ]
                          },
                          "userSelectedKeyword": {
                            "type": "boolean"
                          }
                        }
                      }
                    ]
                  }
                }
              }
            }
          ],
          "properties": {
            "asins": {
              "type": "array",
              "minItems": 0,
              "maxItems": 50,
              "items": {
                "type": "string"
              }
            },
            "recommendationType": {
              "type": "string",
              "enum": [
                "KEYWORDS_FOR_ASINS"
              ]
            }
          }
        }
      ]
    },
    "response": {
      "allOf": [
        {
          "properties": {
            "bid": {
              "type": "number",
              "format": "double"
            },
            "keyword": {
              "type": "string"
            },
            "matchType": {
              "type": "string",
              "enum": [
                "BROAD",
                "EXACT",
                "PHRASE"
              ]
            },
            "userSelectedKeyword": {
              "type": "boolean"
            }
          }
        }
      ],
      "properties": {
        "rank": {
          "type": "number"
        },
        "suggestedBid": {
          "allOf": [
            {
              "properties": {
                "bidRecId": {
                  "type": "string"
                },
                "rangeEnd": {
                  "type": "number",
                  "format": "double"
                },
                "rangeStart": {
                  "type": "number",
                  "format": "double"
                },
                "suggested": {
                  "type": "number",
                  "format": "double"
                }
              }
            }
          ]
        },
        "translation": {
          "type": "string"
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getTargetableASINCounts",
    "family": "sp-research",
    "path": "/sp/targets/products/count",
    "method": "POST",
    "contentType": "application/vnd.spproducttargeting.v3+json",
    "accept": "application/vnd.spproducttargetingresponse.v3+json",
    "request": {
      "type": "object",
      "required": [
        "category"
      ],
      "properties": {
        "ageRanges": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "brands": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "category": {
          "type": "string"
        },
        "genres": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "id": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "isPrimeShipping": {
          "type": "boolean"
        },
        "priceRange": {
          "type": "object",
          "properties": {
            "max": {
              "type": "number",
              "format": "double"
            },
            "min": {
              "type": "number",
              "format": "double"
            }
          }
        },
        "ratingRange": {
          "type": "object",
          "properties": {
            "max": {
              "type": "integer",
              "format": "int32"
            },
            "min": {
              "type": "integer",
              "format": "int32"
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "asinCounts": {
          "type": "object",
          "properties": {
            "max": {
              "type": "integer",
              "format": "int32"
            },
            "min": {
              "type": "integer",
              "format": "int32"
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sp.getProductRecommendations",
    "family": "sp-research",
    "path": "/sp/targets/products/recommendations",
    "method": "POST",
    "contentType": "application/vnd.spproductrecommendation.v3+json",
    "accept": "application/vnd.spproductrecommendationresponse.asins.v3+json",
    "request": {
      "type": "object",
      "required": [
        "adAsins"
      ],
      "properties": {
        "adAsins": {
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 10,
            "maxLength": 10
          }
        },
        "count": {
          "type": "integer",
          "minimum": 1
        },
        "cursor": {
          "type": "string"
        },
        "locale": {
          "type": "string"
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "nextCursor": {
          "type": "string"
        },
        "previousCursor": {
          "type": "string"
        },
        "recommendations": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "recommendedAsin": {
                "type": "string",
                "minLength": 10,
                "maxLength": 10
              },
              "themes": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "9ce8a6b6bc8b33d34d04b7ee416fd78be787699e932075d101941176a215df2e",
    "provenance": "https://d1y2lf8k3vrkfu.cloudfront.net/openapi/en-us/dest/SponsoredProducts_prod_3p.json"
  },
  {
    "operation": "sb.SBTargetingGetNegativeBrands",
    "family": "sb-research",
    "path": "/sb/negativeTargets/brands/recommendations",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.sbtargeting.v4+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "brands": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "object",
            "required": [
              "brandRefinementId"
            ],
            "properties": {
              "brandRefinementId": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.SBOptimizationRecommendation",
    "family": "sb-recommendations",
    "path": "/sb/recommendations/optimization",
    "method": "POST",
    "contentType": "application/vnd.sboptimizationrecommendationresource.v4+json",
    "accept": "application/vnd.sboptimizationrecommendationresource.v4+json",
    "request": {
      "type": "object",
      "required": [
        "costControlMetric",
        "landingPages"
      ],
      "properties": {
        "costControlMetric": {
          "type": "string",
          "enum": [
            "COST_PER_CLICK"
          ]
        },
        "landingPages": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "items": {
            "type": "object",
            "properties": {
              "asins": {
                "type": "array",
                "minItems": 3,
                "maxItems": 100,
                "items": {
                  "type": "string"
                }
              },
              "pageType": {
                "type": "string",
                "enum": [
                  "PRODUCT_LIST",
                  "STORE",
                  "CUSTOM_URL",
                  "DETAIL_PAGE"
                ]
              },
              "url": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "costControlMetric",
        "minimumValue",
        "recommendedValue"
      ],
      "properties": {
        "minimumValue": {
          "type": "number",
          "format": "double"
        },
        "costControlMetric": {
          "type": "string",
          "enum": [
            "COST_PER_CLICK"
          ]
        },
        "recommendedValue": {
          "type": "number",
          "format": "double"
        }
      }
    },
    "parameters": [],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.getHeadlineRecommendations",
    "family": "sb-recommendations",
    "path": "/sb/recommendations/creative/headline",
    "method": "POST",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {
        "asins": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "items": {
            "type": "string"
          }
        },
        "storePages": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "items": {
            "type": "object",
            "properties": {
              "displayName": {
                "type": "string"
              },
              "primaryAsin": {
                "type": "string"
              }
            }
          }
        },
        "maxNumSuggestions": {
          "type": "number",
          "minimum": 1,
          "maximum": 10
        },
        "adFormat": {
          "type": "string",
          "enum": [
            "SPONSORED_BRANDS",
            "SPONSORED_BRANDS_SPOTLIGHT"
          ]
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string"
        },
        "suggestions": {
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "headlineId": {
                "type": "string"
              },
              "headline": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.GetBudgetRecommendations",
    "family": "sb-recommendations",
    "path": "/sb/campaigns/budgetRecommendations",
    "method": "POST",
    "contentType": "application/vnd.sbbudgetrecommendation.v4+json",
    "accept": "application/vnd.sbbudgetrecommendation.v4+json",
    "request": {
      "type": "object",
      "required": [
        "campaignIds"
      ],
      "properties": {
        "campaignIds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "error",
        "success"
      ],
      "properties": {
        "success": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "index",
              "sevenDaysMissedOpportunities",
              "suggestedBudget"
            ],
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "suggestedBudget": {
                "type": "number",
                "format": "double"
              },
              "index": {
                "type": "number"
              },
              "sevenDaysMissedOpportunities": {
                "type": "object",
                "properties": {
                  "estimatedMissedSalesLower": {
                    "type": "number",
                    "format": "double"
                  },
                  "estimatedMissedSalesUpper": {
                    "type": "number",
                    "format": "double"
                  },
                  "endDate": {
                    "type": "string"
                  },
                  "estimatedMissedImpressionsLower": {
                    "type": "number"
                  },
                  "estimatedMissedClicksLower": {
                    "type": "number"
                  },
                  "estimatedMissedClicksUpper": {
                    "type": "number"
                  },
                  "estimatedMissedImpressionsUpper": {
                    "type": "number"
                  },
                  "startDate": {
                    "type": "string"
                  },
                  "percentTimeInBudget": {
                    "type": "number",
                    "format": "double"
                  }
                }
              }
            }
          }
        },
        "error": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "code",
              "details",
              "index"
            ],
            "properties": {
              "code": {
                "type": "string"
              },
              "campaignId": {
                "type": "string"
              },
              "index": {
                "type": "number"
              },
              "details": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.SBTargetingGetTargetableCategories",
    "family": "sb-research",
    "path": "/sb/targets/categories",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.sbtargeting.v4+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "categoryTree": {
          "type": "array",
          "maxItems": 5000,
          "items": {
            "type": "object",
            "properties": {
              "asinCountRange": {
                "type": "object",
                "properties": {
                  "min": {
                    "type": "integer"
                  },
                  "max": {
                    "type": "integer"
                  }
                }
              },
              "isTargetable": {
                "type": "boolean"
              },
              "parentCategoryRefinementId": {
                "type": "string"
              },
              "estimatedReach": {
                "type": "object",
                "properties": {
                  "min": {
                    "type": "integer"
                  },
                  "max": {
                    "type": "integer"
                  }
                }
              },
              "name": {
                "type": "string"
              },
              "translatedName": {
                "type": "string"
              },
              "categoryRefinementId": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "locale",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string",
          "enum": [
            "ar_AE",
            "de_DE",
            "en_AE",
            "en_AU",
            "en_CA",
            "en_GB",
            "en_IN",
            "en_SG",
            "en_US",
            "es_ES",
            "es_MX",
            "fr_CA",
            "fr_FR",
            "hi_IN",
            "it_IT",
            "ja_JP",
            "ko_KR",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "sv_SE",
            "ta_IN",
            "th_TH",
            "tr_TR",
            "vi_VN",
            "zh_CN"
          ]
        }
      },
      {
        "name": "supplySource",
        "location": "query",
        "required": true,
        "schema": {
          "type": "string",
          "enum": [
            "AMAZON",
            "STREAMING_VIDEO"
          ]
        }
      },
      {
        "name": "includeOnlyRootCategories",
        "location": "query",
        "required": false,
        "schema": {
          "type": "boolean"
        }
      },
      {
        "name": "parentCategoryRefinementId",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.SBTargetingGetTargetableASINCounts",
    "family": "sb-research",
    "path": "/sb/targets/products/count",
    "method": "POST",
    "contentType": "application/vnd.sbtargeting.v4+json",
    "accept": "application/vnd.sbtargeting.v4+json",
    "request": {
      "type": "object",
      "required": [
        "category"
      ],
      "properties": {
        "ageRanges": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        },
        "brands": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        },
        "genres": {
          "type": "array",
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        },
        "isPrimeShipping": {
          "type": "boolean"
        },
        "ratingRange": {
          "type": "object",
          "properties": {
            "min": {
              "type": "integer",
              "minimum": 0,
              "maximum": 5
            },
            "max": {
              "type": "integer",
              "minimum": 0,
              "maximum": 5
            }
          }
        },
        "category": {
          "type": "string"
        },
        "priceRange": {
          "type": "object",
          "properties": {
            "min": {
              "type": "number",
              "format": "double"
            },
            "max": {
              "type": "number",
              "format": "double"
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "asinCounts": {
          "type": "object",
          "properties": {
            "min": {
              "type": "integer"
            },
            "max": {
              "type": "integer"
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.SBTargetingGetRefinementsForCategory",
    "family": "sb-research",
    "path": "/sb/targets/categories/{categoryRefinementId}/refinements",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/vnd.sbtargeting.v4+json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "ageRanges": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "object",
            "required": [
              "ageRangeRefinementId"
            ],
            "properties": {
              "ageRangeRefinementId": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "translatedName": {
                "type": "string"
              }
            }
          }
        },
        "brands": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "object",
            "required": [
              "brandRefinementId"
            ],
            "properties": {
              "brandRefinementId": {
                "type": "string"
              },
              "name": {
                "type": "string"
              }
            }
          }
        },
        "genres": {
          "type": "array",
          "maxItems": 500,
          "items": {
            "type": "object",
            "required": [
              "genreRefinementId"
            ],
            "properties": {
              "genreRefinementId": {
                "type": "string"
              },
              "name": {
                "type": "string"
              },
              "translatedName": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "categoryRefinementId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "locale",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string",
          "enum": [
            "ar_AE",
            "de_DE",
            "en_AE",
            "en_AU",
            "en_CA",
            "en_GB",
            "en_IN",
            "en_SG",
            "en_US",
            "es_ES",
            "es_MX",
            "fr_CA",
            "fr_FR",
            "hi_IN",
            "it_IT",
            "ja_JP",
            "ko_KR",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "sv_SE",
            "ta_IN",
            "th_TH",
            "tr_TR",
            "vi_VN",
            "zh_CN"
          ]
        }
      },
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.SBInsightsCampaignInsights",
    "family": "sb-recommendations",
    "path": "/sb/campaigns/insights",
    "method": "POST",
    "contentType": "application/vnd.sbinsights.v4+json",
    "accept": "application/vnd.sbinsights.v4+json",
    "request": {
      "type": "object",
      "required": [
        "adGroups"
      ],
      "properties": {
        "adGroups": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "type": "object",
            "required": [
              "adFormat"
            ],
            "properties": {
              "keywords": {
                "type": "array",
                "minItems": 0,
                "maxItems": 800,
                "items": {
                  "type": "object",
                  "required": [
                    "bid",
                    "keywordText",
                    "matchType"
                  ],
                  "properties": {
                    "matchType": {
                      "type": "string",
                      "enum": [
                        "EXACT",
                        "PHRASE",
                        "BROAD"
                      ]
                    },
                    "bid": {
                      "type": "number",
                      "format": "double"
                    },
                    "keywordText": {
                      "type": "string"
                    }
                  }
                }
              },
              "adFormat": {
                "type": "string",
                "enum": [
                  "PRODUCT_COLLECTION",
                  "STORE_SPOTLIGHT",
                  "VIDEO",
                  "BRAND_VIDEO"
                ]
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "insights": {
          "type": "array",
          "minItems": 0,
          "maxItems": 1000,
          "items": {
            "oneOf": [
              {
                "type": "object",
                "required": [
                  "keywordInsight"
                ],
                "properties": {
                  "keywordInsight": {
                    "type": "object",
                    "properties": {
                      "alerts": {
                        "type": "array",
                        "minItems": 0,
                        "maxItems": 10,
                        "items": {
                          "type": "string",
                          "enum": [
                            "LOW_KEYWORD_TRAFFIC",
                            "LOW_BID"
                          ]
                        }
                      },
                      "searchTermImpressionShare": {
                        "type": "number",
                        "minimum": 0,
                        "maximum": 100,
                        "format": "double"
                      },
                      "matchType": {
                        "type": "string",
                        "enum": [
                          "EXACT",
                          "PHRASE",
                          "BROAD"
                        ]
                      },
                      "adGroupIndex": {
                        "type": "integer"
                      },
                      "searchTermImpressionRank": {
                        "type": "integer"
                      },
                      "bid": {
                        "type": "number",
                        "format": "double"
                      },
                      "keywordIndex": {
                        "type": "integer"
                      },
                      "keywordText": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            ]
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.GetSBBudgetRulesForAdvertiser",
    "family": "sb-recommendations",
    "path": "/sb/budgetRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "budgetRulesForAdvertiserResponse": {
          "type": "array",
          "minItems": 0,
          "maxItems": 30,
          "items": {
            "type": "object",
            "required": [
              "ruleId"
            ],
            "properties": {
              "ruleState": {
                "type": "string",
                "enum": [
                  "ACTIVE",
                  "PAUSED"
                ]
              },
              "lastUpdatedDate": {
                "type": "number",
                "format": "int64"
              },
              "createdDate": {
                "type": "number",
                "format": "int64"
              },
              "ruleDetails": {
                "type": "object",
                "properties": {
                  "duration": {
                    "type": "object",
                    "properties": {
                      "eventTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "eventId"
                        ],
                        "properties": {
                          "eventId": {
                            "type": "string"
                          },
                          "endDate": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      },
                      "dateRangeTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "startDate"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY",
                          "WEEKLY"
                        ]
                      },
                      "daysOfWeek": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "MONDAY",
                            "TUESDAY",
                            "WEDNESDAY",
                            "THURSDAY",
                            "FRIDAY",
                            "SATURDAY",
                            "SUNDAY"
                          ]
                        }
                      },
                      "intraDaySchedule": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "properties": {
                            "startTime": {
                              "type": "string"
                            },
                            "endTime": {
                              "type": "string"
                            }
                          }
                        }
                      }
                    }
                  },
                  "ruleType": {
                    "type": "string",
                    "enum": [
                      "SCHEDULE",
                      "PERFORMANCE"
                    ]
                  },
                  "budgetIncreaseBy": {
                    "type": "object",
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "PERCENT"
                        ]
                      },
                      "value": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 355
                  },
                  "performanceMeasureCondition": {
                    "type": "object",
                    "required": [
                      "comparisonOperator",
                      "metricName",
                      "threshold"
                    ],
                    "properties": {
                      "metricName": {
                        "type": "string",
                        "enum": [
                          "IS",
                          "NTB",
                          "ROAS"
                        ]
                      },
                      "comparisonOperator": {
                        "type": "string",
                        "enum": [
                          "GREATER_THAN",
                          "LESS_THAN",
                          "LESS_THAN_OR_EQUAL_TO",
                          "GREATER_THAN_OR_EQUAL_TO"
                        ]
                      },
                      "threshold": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  }
                }
              },
              "ruleId": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "pageSize",
        "location": "query",
        "required": true,
        "schema": {
          "type": "number"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.GetBudgetRuleByRuleIdForSBCampaigns",
    "family": "sb-recommendations",
    "path": "/sb/budgetRules/{budgetRuleId}",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "budgetRule": {
          "type": "object",
          "required": [
            "ruleId"
          ],
          "properties": {
            "ruleState": {
              "type": "string",
              "enum": [
                "ACTIVE",
                "PAUSED"
              ]
            },
            "lastUpdatedDate": {
              "type": "number",
              "format": "int64"
            },
            "createdDate": {
              "type": "number",
              "format": "int64"
            },
            "ruleDetails": {
              "type": "object",
              "properties": {
                "duration": {
                  "type": "object",
                  "properties": {
                    "eventTypeRuleDuration": {
                      "type": "object",
                      "required": [
                        "eventId"
                      ],
                      "properties": {
                        "eventId": {
                          "type": "string"
                        },
                        "endDate": {
                          "type": "string"
                        },
                        "eventName": {
                          "type": "string"
                        },
                        "startDate": {
                          "type": "string"
                        }
                      }
                    },
                    "dateRangeTypeRuleDuration": {
                      "type": "object",
                      "required": [
                        "startDate"
                      ],
                      "properties": {
                        "endDate": {
                          "type": "string"
                        },
                        "startDate": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "recurrence": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "DAILY",
                        "WEEKLY"
                      ]
                    },
                    "daysOfWeek": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "MONDAY",
                          "TUESDAY",
                          "WEDNESDAY",
                          "THURSDAY",
                          "FRIDAY",
                          "SATURDAY",
                          "SUNDAY"
                        ]
                      }
                    },
                    "intraDaySchedule": {
                      "type": "array",
                      "maxItems": 1,
                      "items": {
                        "type": "object",
                        "properties": {
                          "startTime": {
                            "type": "string"
                          },
                          "endTime": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  }
                },
                "ruleType": {
                  "type": "string",
                  "enum": [
                    "SCHEDULE",
                    "PERFORMANCE"
                  ]
                },
                "budgetIncreaseBy": {
                  "type": "object",
                  "required": [
                    "type",
                    "value"
                  ],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "PERCENT"
                      ]
                    },
                    "value": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                },
                "name": {
                  "type": "string",
                  "maxLength": 355
                },
                "performanceMeasureCondition": {
                  "type": "object",
                  "required": [
                    "comparisonOperator",
                    "metricName",
                    "threshold"
                  ],
                  "properties": {
                    "metricName": {
                      "type": "string",
                      "enum": [
                        "IS",
                        "NTB",
                        "ROAS"
                      ]
                    },
                    "comparisonOperator": {
                      "type": "string",
                      "enum": [
                        "GREATER_THAN",
                        "LESS_THAN",
                        "LESS_THAN_OR_EQUAL_TO",
                        "GREATER_THAN_OR_EQUAL_TO"
                      ]
                    },
                    "threshold": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                }
              }
            },
            "ruleId": {
              "type": "string"
            },
            "ruleStatus": {
              "type": "string"
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "budgetRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.ListAssociatedBudgetRulesForSBCampaigns",
    "family": "sb-recommendations",
    "path": "/sb/campaigns/{campaignId}/budgetRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "associatedRules": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "ruleId"
            ],
            "properties": {
              "ruleState": {
                "type": "string",
                "enum": [
                  "ACTIVE",
                  "PAUSED"
                ]
              },
              "lastUpdatedDate": {
                "type": "number",
                "format": "int64"
              },
              "createdDate": {
                "type": "number",
                "format": "int64"
              },
              "ruleDetails": {
                "type": "object",
                "properties": {
                  "duration": {
                    "type": "object",
                    "properties": {
                      "eventTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "eventId"
                        ],
                        "properties": {
                          "eventId": {
                            "type": "string"
                          },
                          "endDate": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      },
                      "dateRangeTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "startDate"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY",
                          "WEEKLY"
                        ]
                      },
                      "daysOfWeek": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "MONDAY",
                            "TUESDAY",
                            "WEDNESDAY",
                            "THURSDAY",
                            "FRIDAY",
                            "SATURDAY",
                            "SUNDAY"
                          ]
                        }
                      },
                      "intraDaySchedule": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "properties": {
                            "startTime": {
                              "type": "string"
                            },
                            "endTime": {
                              "type": "string"
                            }
                          }
                        }
                      }
                    }
                  },
                  "ruleType": {
                    "type": "string",
                    "enum": [
                      "SCHEDULE",
                      "PERFORMANCE"
                    ]
                  },
                  "budgetIncreaseBy": {
                    "type": "object",
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "PERCENT"
                        ]
                      },
                      "value": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 355
                  },
                  "performanceMeasureCondition": {
                    "type": "object",
                    "required": [
                      "comparisonOperator",
                      "metricName",
                      "threshold"
                    ],
                    "properties": {
                      "metricName": {
                        "type": "string",
                        "enum": [
                          "IS",
                          "NTB",
                          "ROAS"
                        ]
                      },
                      "comparisonOperator": {
                        "type": "string",
                        "enum": [
                          "GREATER_THAN",
                          "LESS_THAN",
                          "LESS_THAN_OR_EQUAL_TO",
                          "GREATER_THAN_OR_EQUAL_TO"
                        ]
                      },
                      "threshold": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  }
                }
              },
              "ruleId": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "campaignId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "number",
          "format": "int64"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.GetCampaignsAssociatedWithSBBudgetRule",
    "family": "sb-recommendations",
    "path": "/sb/budgetRules/{budgetRuleId}/campaigns",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "associatedCampaigns": {
          "type": "array",
          "minItems": 0,
          "maxItems": 30,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "campaignName",
              "ruleStatus"
            ],
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              },
              "campaignName": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "budgetRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "pageSize",
        "location": "query",
        "required": true,
        "schema": {
          "type": "number"
        }
      }
    ],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.SBCampaignPerformanceForecasts",
    "family": "sb-forecast",
    "path": "/sb/forecasts",
    "method": "POST",
    "contentType": "application/vnd.sbforecasting.v4+json",
    "accept": "application/vnd.sbforecasting.v4+json",
    "request": {
      "type": "object",
      "required": [
        "campaigns"
      ],
      "properties": {
        "campaigns": {
          "type": "array",
          "minItems": 1,
          "maxItems": 1,
          "items": {
            "type": "object",
            "required": [
              "adGroups",
              "budget",
              "budgetType",
              "forecastType"
            ],
            "properties": {
              "budget": {
                "type": "number",
                "format": "double"
              },
              "budgetType": {
                "type": "string"
              },
              "forecastType": {
                "type": "string"
              },
              "startDate": {
                "type": "string",
                "format": "date-time"
              },
              "endDate": {
                "type": "string",
                "format": "date-time"
              },
              "goal": {
                "type": "string"
              },
              "adGroups": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1,
                "items": {
                  "type": "object",
                  "properties": {
                    "targets": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 100,
                      "items": {
                        "type": "object",
                        "properties": {
                          "expressions": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "properties": {
                                "type": {
                                  "type": "string"
                                },
                                "value": {
                                  "type": "string"
                                }
                              }
                            }
                          },
                          "bid": {
                            "type": "number",
                            "format": "float"
                          }
                        }
                      }
                    },
                    "negativeTargets": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 100,
                      "items": {
                        "type": "object",
                        "properties": {
                          "expressions": {
                            "type": "array",
                            "minItems": 0,
                            "maxItems": 100,
                            "items": {
                              "type": "object",
                              "properties": {
                                "type": {
                                  "type": "string"
                                },
                                "value": {
                                  "type": "string"
                                }
                              }
                            }
                          }
                        }
                      }
                    },
                    "landingPages": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 100,
                      "items": {
                        "type": "object",
                        "properties": {
                          "landingPageUrl": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "themes": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 100,
                      "items": {
                        "type": "object",
                        "properties": {
                          "themeType": {
                            "type": "string"
                          },
                          "bid": {
                            "type": "number",
                            "format": "float"
                          }
                        }
                      }
                    },
                    "keywords": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 100,
                      "items": {
                        "type": "object",
                        "properties": {
                          "keywordText": {
                            "type": "string"
                          },
                          "matchType": {
                            "type": "string"
                          },
                          "bid": {
                            "type": "number",
                            "format": "float"
                          }
                        }
                      }
                    },
                    "negativeKeywords": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 100,
                      "items": {
                        "type": "object",
                        "properties": {
                          "keywordText": {
                            "type": "string"
                          },
                          "matchType": {
                            "type": "string"
                          }
                        }
                      }
                    },
                    "creativeAsins": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "minItems": 0,
                        "maxItems": 1000
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "campaigns": {
          "type": "object",
          "properties": {
            "successes": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "index": {
                    "type": "integer"
                  },
                  "campaign": {
                    "type": "object",
                    "properties": {
                      "forecasts": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 2,
                        "items": {
                          "type": "object",
                          "properties": {
                            "metric": {
                              "type": "string"
                            },
                            "value": {
                              "type": "object",
                              "properties": {
                                "min": {
                                  "type": "number",
                                  "minimum": 0,
                                  "maximum": 10000,
                                  "format": "float"
                                },
                                "max": {
                                  "type": "number",
                                  "minimum": 0,
                                  "maximum": 10000,
                                  "format": "float"
                                }
                              }
                            }
                          }
                        }
                      },
                      "forecastTimestamp": {
                        "type": "string"
                      }
                    }
                  }
                }
              }
            },
            "errors": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1,
              "items": {
                "type": "object",
                "properties": {
                  "index": {
                    "type": "integer"
                  },
                  "code": {
                    "type": "string"
                  },
                  "description": {
                    "type": "string"
                  }
                }
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sb.ListSponsoredBrandsOptimizationRules",
    "family": "rule-evidence",
    "path": "/sb/rules/optimization/list",
    "method": "POST",
    "contentType": "application/vnd.sbruleoptimization.v4+json",
    "accept": "application/vnd.sbruleoptimization.v4+json",
    "request": {
      "type": "object",
      "properties": {
        "entityFilter": {
          "type": "object",
          "properties": {
            "entityType": {
              "type": "string"
            },
            "entityId": {
              "type": "string"
            }
          }
        },
        "maxResults": {
          "type": "number",
          "minimum": 1,
          "maximum": 100
        },
        "nextToken": {
          "type": "string"
        },
        "optimizationRuleIdFilter": {
          "type": "object",
          "properties": {
            "include": {
              "type": "array",
              "minItems": 0,
              "maxItems": 10,
              "items": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "required": [
        "optimizationRules"
      ],
      "properties": {
        "nextToken": {
          "type": "string"
        },
        "totalCount": {
          "type": "number"
        },
        "optimizationRules": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "object",
            "properties": {
              "optimizationRuleId": {
                "type": "string"
              },
              "conditions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1,
                "items": {
                  "type": "object",
                  "required": [
                    "attributeName",
                    "criteria"
                  ],
                  "properties": {
                    "criteria": {
                      "type": "object",
                      "properties": {
                        "comparisonOperator": {
                          "type": "string"
                        },
                        "value": {
                          "type": "number",
                          "format": "double"
                        }
                      }
                    },
                    "attributeName": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "8da5a350a407b9e90a3bd10334a798c03832d1358ae74e4bf9b783e5f0c1cbfb",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-brands/4-0/openapi.json"
  },
  {
    "operation": "sd.getTargetRecommendations",
    "family": "sd-recommendations",
    "path": "/sd/targets/recommendations",
    "method": "POST",
    "contentType": "application/vnd.sdtargetingrecommendations.v3.5+json",
    "accept": "application/vnd.sdtargetingrecommendations.v3.5+json",
    "request": {
      "required": [
        "tactic",
        "products",
        "typeFilter"
      ],
      "properties": {
        "tactic": {
          "type": "string",
          "enum": [
            "T00020",
            "T00030"
          ]
        },
        "products": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10000,
          "items": {
            "properties": {
              "asin": {
                "type": "string"
              },
              "landingPageType": {
                "type": "string",
                "enum": [
                  "OFF_AMAZON_LINK"
                ]
              },
              "landingPageURL": {
                "type": "string"
              }
            }
          }
        },
        "typeFilter": {
          "type": "array",
          "minItems": 1,
          "maxItems": 3,
          "items": {
            "type": "string",
            "enum": [
              "PRODUCT",
              "CATEGORY",
              "AUDIENCE",
              "CONTENT_CATEGORY"
            ]
          }
        },
        "themes": {
          "type": "object",
          "properties": {
            "product": {
              "type": "array",
              "minItems": 0,
              "maxItems": 5,
              "items": {
                "type": "object",
                "required": [
                  "name",
                  "expression"
                ],
                "properties": {
                  "name": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 100
                  },
                  "expression": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 1,
                    "items": {
                      "type": "object",
                      "required": [
                        "type"
                      ],
                      "properties": {
                        "type": {
                          "type": "string",
                          "enum": [
                            "asinPriceGreaterThan",
                            "asinBrandSameAs",
                            "asinReviewRatingLessThan",
                            "asinGlanceViewsGreaterThan"
                          ]
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "categoryType": {
          "type": "string",
          "enum": [
            "views",
            "purchases"
          ]
        },
        "locationExpression": {
          "type": "array",
          "minItems": 1,
          "maxItems": 20,
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "location"
                ]
              },
              "value": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "response": {
      "properties": {
        "recommendations": {
          "type": "object",
          "properties": {
            "products": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "type": "object",
                "properties": {
                  "products": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 1000,
                    "items": {
                      "type": "object",
                      "properties": {
                        "asin": {
                          "type": "string"
                        },
                        "rank": {
                          "type": "integer",
                          "minimum": 1
                        },
                        "advertisedAsins": {
                          "type": "array",
                          "minItems": 1,
                          "maxItems": 5,
                          "items": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  }
                }
              }
            },
            "categories": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "properties": {
                  "category": {
                    "type": "integer"
                  },
                  "name": {
                    "type": "string"
                  },
                  "translatedName": {
                    "type": "string"
                  },
                  "path": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string"
                    }
                  },
                  "translatedPath": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string"
                    }
                  },
                  "targetableAsinCountRange": {
                    "type": "object",
                    "properties": {
                      "rangeLower": {
                        "type": "integer"
                      },
                      "rangeUpper": {
                        "type": "integer"
                      }
                    }
                  },
                  "rank": {
                    "type": "integer",
                    "minimum": 1
                  }
                }
              }
            },
            "audiences": {
              "type": "array",
              "minItems": 0,
              "maxItems": 10,
              "items": {
                "properties": {
                  "category": {
                    "type": "string",
                    "enum": [
                      "In-market",
                      "Lifestyle",
                      "Interest",
                      "Life event"
                    ]
                  },
                  "audiences": {
                    "type": "array",
                    "minItems": 0,
                    "maxItems": 1000,
                    "items": {
                      "properties": {
                        "audience": {
                          "type": "string"
                        },
                        "name": {
                          "type": "string"
                        },
                        "rank": {
                          "type": "integer",
                          "minimum": 1
                        }
                      }
                    }
                  }
                }
              }
            },
            "contentCategories": {
              "type": "array",
              "minItems": 0,
              "maxItems": 1000,
              "items": {
                "properties": {
                  "contentCategory": {
                    "type": "string"
                  },
                  "name": {
                    "type": "string"
                  },
                  "rank": {
                    "type": "integer",
                    "minimum": 1
                  }
                }
              }
            },
            "themes": {
              "type": "object",
              "properties": {
                "themes": {
                  "properties": {
                    "products": {
                      "type": "array",
                      "minItems": 1,
                      "maxItems": 5,
                      "items": {
                        "oneOf": [
                          {
                            "type": "object",
                            "properties": {
                              "code": {
                                "type": "string"
                              },
                              "name": {
                                "type": "string"
                              },
                              "expression": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 1,
                                "items": {
                                  "type": "object",
                                  "required": [
                                    "type"
                                  ],
                                  "properties": {
                                    "type": {
                                      "type": "string",
                                      "enum": [
                                        "asinPriceGreaterThan",
                                        "asinBrandSameAs",
                                        "asinReviewRatingLessThan",
                                        "asinGlanceViewsGreaterThan"
                                      ]
                                    }
                                  }
                                }
                              },
                              "recommendations": {
                                "type": "array",
                                "minItems": 1,
                                "maxItems": 100,
                                "items": {
                                  "type": "object",
                                  "properties": {
                                    "asin": {
                                      "type": "string"
                                    },
                                    "rank": {
                                      "type": "integer",
                                      "minimum": 1
                                    },
                                    "advertisedAsins": {
                                      "type": "array",
                                      "minItems": 1,
                                      "maxItems": 5,
                                      "items": {
                                        "type": "string"
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "locale",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string",
          "enum": [
            "ar_AE",
            "de_DE",
            "en_AE",
            "en_AU",
            "en_CA",
            "en_GB",
            "en_IN",
            "en_SG",
            "en_US",
            "es_ES",
            "es_MX",
            "fr_CA",
            "fr_FR",
            "hi_IN",
            "it_IT",
            "ja_JP",
            "ko_KR",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "sv_SE",
            "ta_IN",
            "th_TH",
            "tr_TR",
            "vi_VN",
            "zh_CN"
          ]
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.getSDBudgetRecommendations",
    "family": "sd-recommendations",
    "path": "/sd/campaigns/budgetRecommendations",
    "method": "POST",
    "contentType": "application/vnd.sdbudgetrecommendations.v3+json",
    "accept": "application/vnd.sdbudgetrecommendations.v3+json",
    "request": {
      "required": [
        "campaignIds"
      ],
      "properties": {
        "campaignIds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        }
      }
    },
    "response": {
      "required": [
        "budgetRecommendationsSuccessResults",
        "budgetRecommendationsErrorResults"
      ],
      "properties": {
        "budgetRecommendationsSuccessResults": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "required": [
              "index",
              "campaignId",
              "suggestedBudget",
              "sevenDaysMissedOpportunities"
            ],
            "properties": {
              "index": {
                "type": "integer"
              },
              "campaignId": {
                "type": "string"
              },
              "suggestedBudget": {
                "type": "number"
              },
              "sevenDaysMissedOpportunities": {
                "properties": {
                  "startDate": {
                    "type": "string",
                    "format": "date"
                  },
                  "endDate": {
                    "type": "string",
                    "format": "date"
                  },
                  "percentTimeInBudget": {
                    "type": "number"
                  },
                  "estimatedMissedSalesLower": {
                    "type": "number"
                  },
                  "estimatedMissedSalesUpper": {
                    "type": "number"
                  },
                  "estimatedMissedClicksLower": {
                    "type": "integer"
                  },
                  "estimatedMissedClicksUpper": {
                    "type": "integer"
                  },
                  "estimatedMissedImpressionsLower": {
                    "type": "integer"
                  },
                  "estimatedMissedImpressionsUpper": {
                    "type": "integer"
                  },
                  "estimatedMissedViewableImpressionsLower": {
                    "type": "integer"
                  },
                  "estimatedMissedViewableImpressionsUpper": {
                    "type": "integer"
                  }
                }
              }
            }
          }
        },
        "budgetRecommendationsErrorResults": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "required": [
              "index",
              "campaignId",
              "code",
              "details"
            ],
            "properties": {
              "index": {
                "type": "integer"
              },
              "campaignId": {
                "type": "string"
              },
              "code": {
                "type": "string"
              },
              "details": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.getTargetBidRecommendations",
    "family": "sd-recommendations",
    "path": "/sd/targets/bid/recommendations",
    "method": "POST",
    "contentType": "application/vnd.sdtargetingrecommendations.v3.4+json",
    "accept": "application/vnd.sdtargetingrecommendations.v3.3+json",
    "request": {
      "required": [
        "targetingClauses",
        "bidOptimization",
        "costType"
      ],
      "properties": {
        "products": {
          "type": "array",
          "minItems": 0,
          "maxItems": 10000,
          "items": {
            "required": [
              "asin"
            ],
            "properties": {
              "asin": {
                "type": "string"
              }
            }
          }
        },
        "bidOptimization": {
          "type": "string",
          "enum": [
            "reach",
            "clicks",
            "conversions"
          ]
        },
        "costType": {
          "type": "string",
          "enum": [
            "cpc",
            "vcpm"
          ]
        },
        "creativeType": {
          "type": "string",
          "enum": [
            "IMAGE",
            "VIDEO"
          ],
          "nullable": true
        },
        "targetingClauses": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "object",
            "required": [
              "targetingClause"
            ],
            "properties": {
              "targetingClause": {
                "type": "object",
                "required": [
                  "expressionType",
                  "expression"
                ],
                "properties": {
                  "expressionType": {
                    "type": "string",
                    "enum": [
                      "manual",
                      "auto"
                    ]
                  },
                  "expression": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "required": [
                            "type"
                          ],
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "asinSameAs",
                                "asinCategorySameAs",
                                "asinBrandSameAs",
                                "asinPriceBetween",
                                "asinPriceGreaterThan",
                                "asinPriceLessThan",
                                "asinReviewRatingLessThan",
                                "asinReviewRatingGreaterThan",
                                "asinReviewRatingBetween",
                                "asinIsPrimeShippingEligible",
                                "asinAgeRangeSameAs",
                                "asinGenreSameAs"
                              ]
                            },
                            "value": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "object",
                          "required": [
                            "type",
                            "value"
                          ],
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "views",
                                "audience",
                                "purchases"
                              ]
                            },
                            "value": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "required": [
                                  "type"
                                ],
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "enum": [
                                      "asinCategorySameAs",
                                      "asinBrandSameAs",
                                      "asinPriceBetween",
                                      "asinPriceGreaterThan",
                                      "asinPriceLessThan",
                                      "asinReviewRatingLessThan",
                                      "asinReviewRatingGreaterThan",
                                      "asinReviewRatingBetween",
                                      "similarProduct",
                                      "relatedProduct",
                                      "exactProduct",
                                      "asinIsPrimeShippingEligible",
                                      "asinAgeRangeSameAs",
                                      "asinGenreSameAs",
                                      "audienceSameAs",
                                      "lookback"
                                    ]
                                  },
                                  "value": {
                                    "type": "string"
                                  }
                                }
                              }
                            }
                          }
                        },
                        {
                          "type": "object",
                          "required": [
                            "type",
                            "value"
                          ],
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "contentCategorySameAs"
                              ]
                            },
                            "value": {
                              "type": "string"
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "response": {
      "required": [
        "bidRecommendations",
        "costType",
        "bidOptimization"
      ],
      "properties": {
        "bidOptimization": {
          "type": "string",
          "enum": [
            "reach",
            "clicks",
            "conversions"
          ]
        },
        "costType": {
          "type": "string",
          "enum": [
            "cpc",
            "vcpm"
          ]
        },
        "bidRecommendations": {
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "oneOf": [
              {
                "required": [
                  "code"
                ],
                "allOf": [
                  {
                    "properties": {
                      "code": {
                        "type": "string"
                      }
                    }
                  },
                  {
                    "required": [
                      "rangeLower",
                      "rangeUpper",
                      "recommended"
                    ],
                    "properties": {
                      "rangeLower": {
                        "type": "number"
                      },
                      "rangeUpper": {
                        "type": "number"
                      },
                      "recommended": {
                        "type": "number"
                      }
                    }
                  }
                ]
              },
              {
                "required": [
                  "code",
                  "details"
                ],
                "properties": {
                  "code": {
                    "type": "string"
                  },
                  "details": {
                    "type": "string"
                  }
                }
              }
            ]
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.getHeadlineRecommendationsForSD",
    "family": "sd-recommendations",
    "path": "/sd/recommendations/creative/headline",
    "method": "POST",
    "contentType": "application/vnd.sdheadlinerecommendationrequest.v4.0+json",
    "accept": "application/vnd.sdheadlinerecommendationresponse.v4.0+json",
    "request": {
      "type": "object",
      "properties": {
        "asins": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "type": "string"
          }
        },
        "maxNumRecommendations": {
          "type": "number",
          "minimum": 1,
          "maximum": 10
        },
        "adFormat": {
          "type": "string",
          "enum": [
            "SPONSORED_DISPLAY"
          ]
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "requestId": {
          "type": "string"
        },
        "recommendations": {
          "type": "array",
          "minItems": 1,
          "maxItems": 10,
          "items": {
            "type": "object",
            "properties": {
              "headlineId": {
                "type": "string"
              },
              "headline": {
                "type": "string",
                "maxLength": 50
              }
            }
          }
        }
      }
    },
    "parameters": [],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.listOptimizationRules",
    "family": "rule-evidence",
    "path": "/sd/optimizationRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "array",
      "items": {
        "allOf": [
          {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "enabled",
                  "paused [COMING LATER]"
                ]
              },
              "ruleName": {
                "type": "string"
              },
              "ruleConditions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1,
                "items": {
                  "type": "object",
                  "required": [
                    "metricName",
                    "comparisonOperator",
                    "threshold"
                  ],
                  "properties": {
                    "metricName": {
                      "type": "string",
                      "enum": [
                        "COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS",
                        "COST_PER_CLICK",
                        "COST_PER_ORDER"
                      ]
                    },
                    "comparisonOperator": {
                      "type": "string",
                      "enum": [
                        "LESS_THAN_OR_EQUAL_TO"
                      ]
                    },
                    "threshold": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                }
              }
            }
          },
          {
            "type": "object",
            "properties": {
              "ruleId": {
                "type": "string"
              }
            }
          }
        ]
      }
    },
    "parameters": [
      {
        "name": "startIndex",
        "location": "query",
        "required": false,
        "schema": {
          "type": "integer",
          "format": "int32"
        }
      },
      {
        "name": "count",
        "location": "query",
        "required": false,
        "schema": {
          "type": "integer",
          "format": "int32"
        }
      },
      {
        "name": "stateFilter",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "name",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "optimizationRuleIdFilter",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "adGroupIdFilter",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.get--sd-optimizationRules-optimizationRuleId",
    "family": "rule-evidence",
    "path": "/sd/optimizationRules/{optimizationRuleId}",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "allOf": [
        {
          "type": "object",
          "properties": {
            "state": {
              "type": "string",
              "enum": [
                "enabled",
                "paused [COMING LATER]"
              ]
            },
            "ruleName": {
              "type": "string"
            },
            "ruleConditions": {
              "type": "array",
              "minItems": 1,
              "maxItems": 1,
              "items": {
                "type": "object",
                "required": [
                  "metricName",
                  "comparisonOperator",
                  "threshold"
                ],
                "properties": {
                  "metricName": {
                    "type": "string",
                    "enum": [
                      "COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS",
                      "COST_PER_CLICK",
                      "COST_PER_ORDER"
                    ]
                  },
                  "comparisonOperator": {
                    "type": "string",
                    "enum": [
                      "LESS_THAN_OR_EQUAL_TO"
                    ]
                  },
                  "threshold": {
                    "type": "number",
                    "format": "double"
                  }
                }
              }
            }
          }
        },
        {
          "type": "object",
          "properties": {
            "ruleId": {
              "type": "string"
            }
          }
        }
      ]
    },
    "parameters": [
      {
        "name": "optimizationRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.get--sd-adGroups-adGroupId-optimizationRules",
    "family": "rule-evidence",
    "path": "/sd/adGroups/{adGroupId}/optimizationRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "array",
      "items": {
        "allOf": [
          {
            "type": "object",
            "properties": {
              "state": {
                "type": "string",
                "enum": [
                  "enabled",
                  "paused [COMING LATER]"
                ]
              },
              "ruleName": {
                "type": "string"
              },
              "ruleConditions": {
                "type": "array",
                "minItems": 1,
                "maxItems": 1,
                "items": {
                  "type": "object",
                  "required": [
                    "metricName",
                    "comparisonOperator",
                    "threshold"
                  ],
                  "properties": {
                    "metricName": {
                      "type": "string",
                      "enum": [
                        "COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS",
                        "COST_PER_CLICK",
                        "COST_PER_ORDER"
                      ]
                    },
                    "comparisonOperator": {
                      "type": "string",
                      "enum": [
                        "LESS_THAN_OR_EQUAL_TO"
                      ]
                    },
                    "threshold": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                }
              }
            }
          },
          {
            "type": "object",
            "properties": {
              "ruleId": {
                "type": "string"
              }
            }
          }
        ]
      }
    },
    "parameters": [
      {
        "name": "adGroupId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "integer",
          "format": "int64"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.createSDForecast",
    "family": "sd-forecast",
    "path": "/sd/forecasts",
    "method": "POST",
    "contentType": "application/vnd.sdforecasts.v3.1+json",
    "accept": "application/vnd.sdforecasts.v3.1+json",
    "request": {
      "type": "object",
      "required": [
        "campaign",
        "adGroup",
        "productAds",
        "targetingClauses"
      ],
      "properties": {
        "campaign": {
          "allOf": [
            {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "budgetType": {
                  "type": "string",
                  "enum": [
                    "daily"
                  ]
                },
                "budget": {
                  "type": "number",
                  "format": "double"
                },
                "startDate": {
                  "type": "string"
                },
                "endDate": {
                  "type": "string",
                  "nullable": true
                },
                "costType": {
                  "type": "string",
                  "enum": [
                    "cpc",
                    "vcpm"
                  ]
                },
                "state": {
                  "type": "string",
                  "enum": [
                    "enabled",
                    "paused",
                    "archived"
                  ]
                },
                "portfolioId": {
                  "type": "integer",
                  "nullable": true,
                  "format": "int64"
                }
              }
            },
            {
              "type": "object",
              "properties": {
                "campaignId": {
                  "type": "integer",
                  "format": "int64"
                },
                "tactic": {
                  "type": "string",
                  "enum": [
                    "T00020",
                    "T00030"
                  ]
                },
                "deliveryProfile": {
                  "type": "string",
                  "enum": [
                    "as_soon_as_possible"
                  ]
                },
                "ruleBasedBudget": {
                  "type": "object",
                  "properties": {
                    "isProcessing": {
                      "type": "boolean"
                    },
                    "applicableRuleName": {
                      "type": "string"
                    },
                    "value": {
                      "type": "number",
                      "format": "double"
                    },
                    "applicableRuleId": {
                      "type": "string"
                    }
                  }
                }
              }
            }
          ]
        },
        "adGroup": {
          "allOf": [
            {
              "type": "object",
              "properties": {
                "name": {
                  "type": "string"
                },
                "campaignId": {
                  "type": "integer",
                  "format": "int64"
                },
                "defaultBid": {
                  "type": "number",
                  "format": "double"
                },
                "bidOptimization": {
                  "type": "string",
                  "enum": [
                    "reach",
                    "clicks",
                    "conversions"
                  ]
                },
                "state": {
                  "type": "string",
                  "enum": [
                    "enabled",
                    "paused",
                    "archived"
                  ]
                }
              }
            },
            {
              "type": "object",
              "properties": {
                "adGroupId": {
                  "type": "integer",
                  "format": "int64"
                },
                "tactic": {
                  "type": "string",
                  "enum": [
                    "T00020",
                    "T00030"
                  ]
                },
                "creativeType": {
                  "type": "string",
                  "enum": [
                    "IMAGE",
                    "VIDEO"
                  ],
                  "nullable": true
                }
              }
            }
          ]
        },
        "optimizationRules": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "allOf": [
              {
                "type": "object",
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "enabled",
                      "paused [COMING LATER]"
                    ]
                  },
                  "ruleName": {
                    "type": "string"
                  },
                  "ruleConditions": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 1,
                    "items": {
                      "type": "object",
                      "required": [
                        "metricName",
                        "comparisonOperator",
                        "threshold"
                      ],
                      "properties": {
                        "metricName": {
                          "type": "string",
                          "enum": [
                            "COST_PER_THOUSAND_VIEWABLE_IMPRESSIONS",
                            "COST_PER_CLICK",
                            "COST_PER_ORDER"
                          ]
                        },
                        "comparisonOperator": {
                          "type": "string",
                          "enum": [
                            "LESS_THAN_OR_EQUAL_TO"
                          ]
                        },
                        "threshold": {
                          "type": "number",
                          "format": "double"
                        }
                      }
                    }
                  }
                }
              },
              {
                "type": "object",
                "properties": {
                  "ruleId": {
                    "type": "string"
                  }
                }
              }
            ]
          }
        },
        "productAds": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "allOf": [
              {
                "type": "object",
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "enabled",
                      "paused",
                      "archived"
                    ]
                  }
                }
              },
              {
                "type": "object",
                "properties": {
                  "adId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "adGroupId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "campaignId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "landingPageURL": {
                    "type": "string"
                  },
                  "landingPageType": {
                    "type": "string",
                    "enum": [
                      "STORE",
                      "MOMENT",
                      "OFF_AMAZON_LINK"
                    ]
                  },
                  "adName": {
                    "type": "string"
                  },
                  "asin": {
                    "type": "string"
                  },
                  "sku": {
                    "type": "string"
                  }
                }
              }
            ]
          }
        },
        "targetingClauses": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "allOf": [
              {
                "type": "object",
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "enabled",
                      "paused",
                      "archived"
                    ]
                  },
                  "bid": {
                    "type": "number",
                    "minimum": 0.02,
                    "nullable": true,
                    "format": "float"
                  }
                }
              },
              {
                "type": "object",
                "properties": {
                  "targetId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "adGroupId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "expressionType": {
                    "type": "string",
                    "enum": [
                      "manual",
                      "auto"
                    ]
                  },
                  "expression": {
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "asinSameAs",
                                "asinCategorySameAs",
                                "asinBrandSameAs",
                                "asinPriceBetween",
                                "asinPriceGreaterThan",
                                "asinPriceLessThan",
                                "asinReviewRatingLessThan",
                                "asinReviewRatingGreaterThan",
                                "asinReviewRatingBetween",
                                "asinIsPrimeShippingEligible",
                                "asinAgeRangeSameAs",
                                "asinGenreSameAs",
                                "similarProduct"
                              ]
                            },
                            "value": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "contentCategorySameAs"
                              ]
                            },
                            "value": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "asinSameAs",
                                "asinCategorySameAs",
                                "asinBrandSameAs",
                                "asinPriceBetween",
                                "asinPriceGreaterThan",
                                "asinPriceLessThan",
                                "asinReviewRatingLessThan",
                                "asinReviewRatingGreaterThan",
                                "asinReviewRatingBetween",
                                "similarProduct",
                                "exactProduct",
                                "asinIsPrimeShippingEligible",
                                "asinAgeRangeSameAs",
                                "asinGenreSameAs"
                              ]
                            },
                            "value": {
                              "type": "string"
                            },
                            "eventType": {
                              "type": "string",
                              "enum": [
                                "views"
                              ]
                            }
                          }
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "views",
                                "audience",
                                "purchases"
                              ]
                            },
                            "value": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "enum": [
                                      "asinCategorySameAs",
                                      "asinBrandSameAs",
                                      "asinPriceBetween",
                                      "asinPriceGreaterThan",
                                      "asinPriceLessThan",
                                      "asinReviewRatingLessThan",
                                      "asinReviewRatingGreaterThan",
                                      "asinReviewRatingBetween",
                                      "similarProduct",
                                      "exactProduct",
                                      "asinIsPrimeShippingEligible",
                                      "asinAgeRangeSameAs",
                                      "asinGenreSameAs",
                                      "audienceSameAs",
                                      "lookback",
                                      "negative",
                                      "relatedProduct"
                                    ]
                                  },
                                  "value": {
                                    "type": "string"
                                  }
                                }
                              }
                            }
                          }
                        }
                      ]
                    }
                  },
                  "resolvedExpression": {
                    "type": "array",
                    "items": {
                      "oneOf": [
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "asinSameAs",
                                "asinCategorySameAs",
                                "asinBrandSameAs",
                                "asinPriceBetween",
                                "asinPriceGreaterThan",
                                "asinPriceLessThan",
                                "asinReviewRatingLessThan",
                                "asinReviewRatingGreaterThan",
                                "asinReviewRatingBetween",
                                "asinIsPrimeShippingEligible",
                                "asinAgeRangeSameAs",
                                "asinGenreSameAs",
                                "similarProduct"
                              ]
                            },
                            "value": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "contentCategorySameAs"
                              ]
                            },
                            "value": {
                              "type": "string"
                            }
                          }
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "asinSameAs",
                                "asinCategorySameAs",
                                "asinBrandSameAs",
                                "asinPriceBetween",
                                "asinPriceGreaterThan",
                                "asinPriceLessThan",
                                "asinReviewRatingLessThan",
                                "asinReviewRatingGreaterThan",
                                "asinReviewRatingBetween",
                                "similarProduct",
                                "exactProduct",
                                "asinIsPrimeShippingEligible",
                                "asinAgeRangeSameAs",
                                "asinGenreSameAs"
                              ]
                            },
                            "value": {
                              "type": "string"
                            },
                            "eventType": {
                              "type": "string",
                              "enum": [
                                "views"
                              ]
                            }
                          }
                        },
                        {
                          "type": "object",
                          "properties": {
                            "type": {
                              "type": "string",
                              "enum": [
                                "views",
                                "audience",
                                "purchases"
                              ]
                            },
                            "value": {
                              "type": "array",
                              "items": {
                                "type": "object",
                                "properties": {
                                  "type": {
                                    "type": "string",
                                    "enum": [
                                      "asinCategorySameAs",
                                      "asinBrandSameAs",
                                      "asinPriceBetween",
                                      "asinPriceGreaterThan",
                                      "asinPriceLessThan",
                                      "asinReviewRatingLessThan",
                                      "asinReviewRatingGreaterThan",
                                      "asinReviewRatingBetween",
                                      "similarProduct",
                                      "exactProduct",
                                      "asinIsPrimeShippingEligible",
                                      "asinAgeRangeSameAs",
                                      "asinGenreSameAs",
                                      "audienceSameAs",
                                      "lookback",
                                      "negative",
                                      "relatedProduct"
                                    ]
                                  },
                                  "value": {
                                    "type": "string"
                                  }
                                }
                              }
                            }
                          }
                        }
                      ]
                    }
                  }
                }
              }
            ]
          }
        },
        "negativeTargetingClauses": {
          "type": "array",
          "minItems": 1,
          "maxItems": 100,
          "items": {
            "allOf": [
              {
                "properties": {
                  "state": {
                    "type": "string",
                    "enum": [
                      "enabled",
                      "paused",
                      "archived"
                    ]
                  }
                }
              },
              {
                "type": "object",
                "properties": {
                  "targetId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "adGroupId": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "expressionType": {
                    "type": "string",
                    "enum": [
                      "manual",
                      "auto"
                    ]
                  },
                  "expression": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "type": {
                          "type": "string",
                          "enum": [
                            "asinSameAs",
                            "asinBrandSameAs"
                          ]
                        },
                        "value": {
                          "type": "string"
                        }
                      }
                    }
                  },
                  "resolvedExpression": {
                    "type": "array",
                    "items": {
                      "type": "object",
                      "properties": {
                        "type": {
                          "type": "string",
                          "enum": [
                            "asinSameAs",
                            "asinBrandSameAs"
                          ]
                        },
                        "value": {
                          "type": "string"
                        }
                      }
                    }
                  }
                }
              }
            ]
          }
        },
        "locationExpressions": {
          "type": "array",
          "minItems": 0,
          "maxItems": 100,
          "items": {
            "type": "object",
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "location"
                ]
              },
              "value": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "response": {
      "type": "object",
      "properties": {
        "bidOptimization": {
          "type": "string"
        },
        "lifetimeForecasts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "properties": {
              "metric": {
                "type": "string",
                "enum": [
                  "IMPRESSIONS",
                  "REACH",
                  "CLICKS",
                  "CONVERSIONS"
                ]
              },
              "value": {
                "properties": {
                  "min": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "max": {
                    "type": "integer",
                    "format": "int64"
                  }
                }
              }
            }
          }
        },
        "weeklyForecasts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "properties": {
              "metric": {
                "type": "string",
                "enum": [
                  "IMPRESSIONS",
                  "REACH",
                  "CLICKS",
                  "CONVERSIONS"
                ]
              },
              "value": {
                "properties": {
                  "min": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "max": {
                    "type": "integer",
                    "format": "int64"
                  }
                }
              }
            }
          }
        },
        "dailyForecasts": {
          "type": "array",
          "minItems": 1,
          "maxItems": 4,
          "items": {
            "type": "object",
            "properties": {
              "metric": {
                "type": "string",
                "enum": [
                  "IMPRESSIONS",
                  "REACH",
                  "CLICKS",
                  "CONVERSIONS"
                ]
              },
              "value": {
                "properties": {
                  "min": {
                    "type": "integer",
                    "format": "int64"
                  },
                  "max": {
                    "type": "integer",
                    "format": "int64"
                  }
                }
              }
            }
          }
        },
        "curves": {
          "type": "array",
          "minItems": 0,
          "maxItems": 10,
          "items": {
            "type": "object",
            "properties": {
              "meetThreshold": {
                "type": "boolean"
              },
              "graph": {
                "type": "string",
                "enum": [
                  "BUDGET"
                ]
              },
              "points": {
                "type": "array",
                "minItems": 50,
                "maxItems": 100,
                "items": {
                  "type": "object",
                  "properties": {
                    "isFocus": {
                      "type": "boolean"
                    },
                    "x": {
                      "type": "object",
                      "items": {
                        "type": "object",
                        "properties": {
                          "value": {
                            "type": "number",
                            "format": "double"
                          }
                        }
                      }
                    },
                    "y": {
                      "type": "array",
                      "minItems": 0,
                      "maxItems": 2,
                      "items": {
                        "type": "object",
                        "properties": {
                          "label": {
                            "type": "string",
                            "enum": [
                              "CLICKS",
                              "REACH"
                            ]
                          },
                          "value": {
                            "type": "object",
                            "properties": {
                              "min": {
                                "type": "number",
                                "format": "double"
                              },
                              "mean": {
                                "type": "number",
                                "format": "double"
                              },
                              "max": {
                                "type": "number",
                                "format": "double"
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "forecastStatus": {
          "type": "string",
          "enum": [
            "IMPRESSION_TARGETING_TOO_NARROW",
            "IMPRESSION_TARGETING_TOO_BROAD",
            "COMPLETE"
          ]
        }
      }
    },
    "parameters": [],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.GetBudgetRuleByRuleIdForSDCampaigns",
    "family": "sd-recommendations",
    "path": "/sd/budgetRules/{budgetRuleId}",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "budgetRule": {
          "type": "object",
          "required": [
            "ruleId"
          ],
          "properties": {
            "ruleState": {
              "type": "string",
              "enum": [
                "ACTIVE",
                "PAUSED"
              ]
            },
            "lastUpdatedDate": {
              "type": "number",
              "format": "int64"
            },
            "createdDate": {
              "type": "number",
              "format": "int64"
            },
            "ruleDetails": {
              "type": "object",
              "properties": {
                "duration": {
                  "type": "object",
                  "properties": {
                    "eventTypeRuleDuration": {
                      "type": "object",
                      "required": [
                        "eventId"
                      ],
                      "properties": {
                        "eventId": {
                          "type": "string"
                        },
                        "endDate": {
                          "type": "string"
                        },
                        "eventName": {
                          "type": "string"
                        },
                        "startDate": {
                          "type": "string"
                        }
                      }
                    },
                    "dateRangeTypeRuleDuration": {
                      "type": "object",
                      "required": [
                        "startDate"
                      ],
                      "properties": {
                        "endDate": {
                          "type": "string"
                        },
                        "startDate": {
                          "type": "string"
                        }
                      }
                    }
                  }
                },
                "recurrence": {
                  "type": "object",
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "DAILY",
                        "WEEKLY"
                      ]
                    },
                    "daysOfWeek": {
                      "type": "array",
                      "items": {
                        "type": "string",
                        "enum": [
                          "MONDAY",
                          "TUESDAY",
                          "WEDNESDAY",
                          "THURSDAY",
                          "FRIDAY",
                          "SATURDAY",
                          "SUNDAY"
                        ]
                      }
                    },
                    "intraDaySchedule": {
                      "type": "array",
                      "maxItems": 1,
                      "items": {
                        "type": "object",
                        "properties": {
                          "startTime": {
                            "type": "string"
                          },
                          "endTime": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  }
                },
                "ruleType": {
                  "type": "string",
                  "enum": [
                    "SCHEDULE",
                    "PERFORMANCE"
                  ]
                },
                "budgetIncreaseBy": {
                  "type": "object",
                  "required": [
                    "type",
                    "value"
                  ],
                  "properties": {
                    "type": {
                      "type": "string",
                      "enum": [
                        "PERCENT"
                      ]
                    },
                    "value": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                },
                "name": {
                  "type": "string",
                  "maxLength": 355
                },
                "performanceMeasureCondition": {
                  "type": "object",
                  "required": [
                    "comparisonOperator",
                    "metricName",
                    "threshold"
                  ],
                  "properties": {
                    "metricName": {
                      "type": "string",
                      "enum": [
                        "ACOS",
                        "CTR",
                        "CVR",
                        "ROAS"
                      ]
                    },
                    "comparisonOperator": {
                      "type": "string",
                      "enum": [
                        "GREATER_THAN",
                        "LESS_THAN",
                        "LESS_THAN_OR_EQUAL_TO",
                        "GREATER_THAN_OR_EQUAL_TO"
                      ]
                    },
                    "threshold": {
                      "type": "number",
                      "format": "double"
                    }
                  }
                }
              }
            },
            "ruleId": {
              "type": "string"
            },
            "ruleStatus": {
              "type": "string"
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "budgetRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.GetSDBudgetRulesForAdvertiser",
    "family": "sd-recommendations",
    "path": "/sd/budgetRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "budgetRulesForAdvertiserResponse": {
          "type": "array",
          "minItems": 0,
          "maxItems": 30,
          "items": {
            "type": "object",
            "required": [
              "ruleId"
            ],
            "properties": {
              "ruleState": {
                "type": "string",
                "enum": [
                  "ACTIVE",
                  "PAUSED"
                ]
              },
              "lastUpdatedDate": {
                "type": "number",
                "format": "int64"
              },
              "createdDate": {
                "type": "number",
                "format": "int64"
              },
              "ruleDetails": {
                "type": "object",
                "properties": {
                  "duration": {
                    "type": "object",
                    "properties": {
                      "eventTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "eventId"
                        ],
                        "properties": {
                          "eventId": {
                            "type": "string"
                          },
                          "endDate": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      },
                      "dateRangeTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "startDate"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY",
                          "WEEKLY"
                        ]
                      },
                      "daysOfWeek": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "MONDAY",
                            "TUESDAY",
                            "WEDNESDAY",
                            "THURSDAY",
                            "FRIDAY",
                            "SATURDAY",
                            "SUNDAY"
                          ]
                        }
                      },
                      "intraDaySchedule": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "properties": {
                            "startTime": {
                              "type": "string"
                            },
                            "endTime": {
                              "type": "string"
                            }
                          }
                        }
                      }
                    }
                  },
                  "ruleType": {
                    "type": "string",
                    "enum": [
                      "SCHEDULE",
                      "PERFORMANCE"
                    ]
                  },
                  "budgetIncreaseBy": {
                    "type": "object",
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "PERCENT"
                        ]
                      },
                      "value": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 355
                  },
                  "performanceMeasureCondition": {
                    "type": "object",
                    "required": [
                      "comparisonOperator",
                      "metricName",
                      "threshold"
                    ],
                    "properties": {
                      "metricName": {
                        "type": "string",
                        "enum": [
                          "ACOS",
                          "CTR",
                          "CVR",
                          "ROAS"
                        ]
                      },
                      "comparisonOperator": {
                        "type": "string",
                        "enum": [
                          "GREATER_THAN",
                          "LESS_THAN",
                          "LESS_THAN_OR_EQUAL_TO",
                          "GREATER_THAN_OR_EQUAL_TO"
                        ]
                      },
                      "threshold": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  }
                }
              },
              "ruleId": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "pageSize",
        "location": "query",
        "required": true,
        "schema": {
          "type": "number"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.GetCampaignsAssociatedWithSDBudgetRule",
    "family": "sd-recommendations",
    "path": "/sd/budgetRules/{budgetRuleId}/campaigns",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "associatedCampaigns": {
          "type": "array",
          "minItems": 0,
          "maxItems": 30,
          "items": {
            "type": "object",
            "required": [
              "campaignId",
              "campaignName",
              "ruleStatus"
            ],
            "properties": {
              "campaignId": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              },
              "campaignName": {
                "type": "string"
              }
            }
          }
        },
        "nextToken": {
          "type": "string"
        }
      }
    },
    "parameters": [
      {
        "name": "budgetRuleId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "nextToken",
        "location": "query",
        "required": false,
        "schema": {
          "type": "string"
        }
      },
      {
        "name": "pageSize",
        "location": "query",
        "required": true,
        "schema": {
          "type": "number"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  },
  {
    "operation": "sd.ListAssociatedBudgetRulesForSDCampaigns",
    "family": "sd-recommendations",
    "path": "/sd/campaigns/{campaignId}/budgetRules",
    "method": "GET",
    "contentType": "application/json",
    "accept": "application/json",
    "request": {
      "type": "object",
      "properties": {},
      "required": []
    },
    "response": {
      "type": "object",
      "properties": {
        "associatedRules": {
          "type": "array",
          "items": {
            "type": "object",
            "required": [
              "ruleId"
            ],
            "properties": {
              "ruleState": {
                "type": "string",
                "enum": [
                  "ACTIVE",
                  "PAUSED"
                ]
              },
              "lastUpdatedDate": {
                "type": "number",
                "format": "int64"
              },
              "createdDate": {
                "type": "number",
                "format": "int64"
              },
              "ruleDetails": {
                "type": "object",
                "properties": {
                  "duration": {
                    "type": "object",
                    "properties": {
                      "eventTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "eventId"
                        ],
                        "properties": {
                          "eventId": {
                            "type": "string"
                          },
                          "endDate": {
                            "type": "string"
                          },
                          "eventName": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      },
                      "dateRangeTypeRuleDuration": {
                        "type": "object",
                        "required": [
                          "startDate"
                        ],
                        "properties": {
                          "endDate": {
                            "type": "string"
                          },
                          "startDate": {
                            "type": "string"
                          }
                        }
                      }
                    }
                  },
                  "recurrence": {
                    "type": "object",
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "DAILY",
                          "WEEKLY"
                        ]
                      },
                      "daysOfWeek": {
                        "type": "array",
                        "items": {
                          "type": "string",
                          "enum": [
                            "MONDAY",
                            "TUESDAY",
                            "WEDNESDAY",
                            "THURSDAY",
                            "FRIDAY",
                            "SATURDAY",
                            "SUNDAY"
                          ]
                        }
                      },
                      "intraDaySchedule": {
                        "type": "array",
                        "maxItems": 1,
                        "items": {
                          "type": "object",
                          "properties": {
                            "startTime": {
                              "type": "string"
                            },
                            "endTime": {
                              "type": "string"
                            }
                          }
                        }
                      }
                    }
                  },
                  "ruleType": {
                    "type": "string",
                    "enum": [
                      "SCHEDULE",
                      "PERFORMANCE"
                    ]
                  },
                  "budgetIncreaseBy": {
                    "type": "object",
                    "required": [
                      "type",
                      "value"
                    ],
                    "properties": {
                      "type": {
                        "type": "string",
                        "enum": [
                          "PERCENT"
                        ]
                      },
                      "value": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  },
                  "name": {
                    "type": "string",
                    "maxLength": 355
                  },
                  "performanceMeasureCondition": {
                    "type": "object",
                    "required": [
                      "comparisonOperator",
                      "metricName",
                      "threshold"
                    ],
                    "properties": {
                      "metricName": {
                        "type": "string",
                        "enum": [
                          "ACOS",
                          "CTR",
                          "CVR",
                          "ROAS"
                        ]
                      },
                      "comparisonOperator": {
                        "type": "string",
                        "enum": [
                          "GREATER_THAN",
                          "LESS_THAN",
                          "LESS_THAN_OR_EQUAL_TO",
                          "GREATER_THAN_OR_EQUAL_TO"
                        ]
                      },
                      "threshold": {
                        "type": "number",
                        "format": "double"
                      }
                    }
                  }
                }
              },
              "ruleId": {
                "type": "string"
              },
              "ruleStatus": {
                "type": "string"
              }
            }
          }
        }
      }
    },
    "parameters": [
      {
        "name": "campaignId",
        "location": "path",
        "required": true,
        "schema": {
          "type": "number",
          "format": "int64"
        }
      }
    ],
    "contractHash": "dac6fdb0299a4489bf536c80629f3d26a2a805bce2da0a7940d6b17edf07eedd",
    "provenance": "https://d3a0d0y2hgofx6.cloudfront.net/openapi/en-us/sponsored-display/3-0/openapi.yaml"
  }
];
